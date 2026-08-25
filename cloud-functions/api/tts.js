/* EdgeOne Makers Cloud Function — POST /api/tts
   服务器端直连微软 edge-tts（正确 User-Agent），把 MP3 流式返回给浏览器。
   部署后前端 relay.js 探测到 /api/ping 可用，会自动走本函数中转，
   Chrome / Edge / Safari / Firefox 及手机浏览器都能完整播放。

   依赖：项目根 package.json 中的 ws 包（纯 JS，云函数可直接使用）。

   注意：云函数超时默认 30s，请在项目配置中把 Cloud Functions 的
   maxDuration 调到 120s（一话文本通常 2-4 段，每段合成 15-40s）。

   本地测试：node -e "import('./cloud-functions/api/tts.js').then(async m => {
     const n = await m.synthesizeAll('こんにちは、テストです。', {voice:'ja-JP-NanamiNeural', rate:'+0%', pitch:'+0Hz'}, c => process.stdout.write(c));
     console.error('\nbytes:', n); })"
*/
import crypto from 'node:crypto'
import WebSocket from 'ws'

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_URL =
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/` +
  `edge/v1?TrustedClientToken=${TOKEN}`
const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'
const CHUNK_BYTES = 4096

const VOICE_MAP = {
  nanami: 'ja-JP-NanamiNeural',
  keita: 'ja-JP-KeitaNeural',
}

// ── helpers ────────────────────────────────────────────────────────────────

function hexUUID() {
  const b = crypto.randomBytes(16)
  return b.toString('hex')
}

function generateSecMsGec(nowMs = Date.now()) {
  // Microsoft rejects lowercase hashes with HTTP 403 — must be UPPERCASE
  const WIN_EPOCH = 11644473600n
  let ticks = BigInt(Math.floor(nowMs / 1000))
  ticks += WIN_EPOCH
  ticks -= ticks % 300n
  ticks *= 10000000n
  return crypto.createHash('sha256').update(`${ticks}${TOKEN}`).digest('hex').toUpperCase()
}

function dateToStr(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n) => String(n).padStart(2, '0')
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ` +
    `GMT+0000 (Coordinated Universal Time)`
}

function speechConfigMessage() {
  return (
    `X-Timestamp:${dateToStr()}\r\n` +
    `Content-Type:application/json; charset=utf-8\r\n` +
    `Path:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":` +
    `{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},` +
    `"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`
  )
}

function ssmlMessage(text, { voice, rate, pitch }) {
  const speak =
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'><prosody pitch='${pitch || '+0Hz'}' rate='${rate || '+0%'}' volume='+0%'>` +
    `${text}</prosody></voice></speak>`
  return (
    `X-RequestId:${hexUUID()}\r\n` +
    `Content-Type:application/ssml+xml\r\n` +
    `X-Timestamp:${dateToStr()}Z\r\n` +
    `Path:ssml\r\n\r\n` +
    `${speak}`
  )
}

function parseTextHeaders(msg) {
  const sep = msg.indexOf('\r\n\r\n')
  const head = sep < 0 ? msg : msg.slice(0, sep)
  const headers = {}
  for (const line of head.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    headers[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return headers
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function removeIncompatibleChars(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
}

function utf8Len(s) {
  return Buffer.byteLength(s, 'utf8')
}

function splitTextByBytes(text, maxBytes = CHUNK_BYTES) {
  const chunks = []
  let cur = ''
  const pushIfNeeded = (add) => {
    const joined = cur ? cur + add : add
    if (utf8Len(joined) > maxBytes && cur) {
      chunks.push(cur)
      return add
    }
    return joined
  }
  for (const line of String(text).split(/(?<=[。！？.!?…])/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (utf8Len(trimmed) > maxBytes) {
      // single over-long segment: cut by bytes at UTF-8 boundaries
      const buf = Buffer.from(trimmed, 'utf8')
      let start = 0
      while (start < buf.length) {
        let end = Math.min(start + maxBytes, buf.length)
        while (end > start && (buf[end] & 0xc0) === 0x80) end--
        if (end === start) end = Math.min(start + maxBytes, buf.length)
        chunks.push(buf.subarray(start, end).toString('utf8'))
        start = end
      }
      continue
    }
    cur = pushIfNeeded(trimmed)
  }
  if (cur) chunks.push(cur)
  return chunks
}

// ── synthesis ──────────────────────────────────────────────────────────────

// synthesize one text segment, pushing MP3 frames to onAudio; resolves on turn.end
export function synthesizeSegment(text, opts, onAudio) {
  return new Promise((resolve, reject) => {
    const connId = hexUUID()
    const token = generateSecMsGec(Date.now())
    const url = `${WSS_URL}&ConnectionId=${connId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
    let ws
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent': EDGE_UA,
          Origin: ORIGIN,
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Cookie: `muid=${hexUUID().toUpperCase()};`,
        },
        perMessageDeflate: true,
        handshakeTimeout: 15000,
      })
    } catch (e) {
      reject(e)
      return
    }
    let done = false
    let audioReceived = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { ws.terminate() } catch {}; reject(new Error('edge-tts 连接超时')) }
    }, 90000)

    ws.on('open', () => {
      ws.send(speechConfigMessage())
      ws.send(ssmlMessage(text, opts))
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = data
        if (buf.length < 2) return
        const hl = (buf[0] << 8) | buf[1]
        if (2 + hl > buf.length) return
        const head = buf.slice(2, 2 + hl).toString()
        const h = parseTextHeaders(head)
        if (h.Path === 'audio' && h['Content-Type'] === 'audio/mpeg') {
          audioReceived = true
          onAudio(buf.slice(2 + hl))
        }
        return
      }
      const h = parseTextHeaders(data.toString())
      if (h.Path === 'turn.end') {
        if (done) return
        done = true
        clearTimeout(timer)
        try { ws.close() } catch {}
        resolve()
      }
    })
    ws.on('error', (e) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error('edge-tts 连接失败: ' + e.message))
    })
    ws.on('close', () => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (!audioReceived) reject(new Error('edge-tts 未返回音频'))
      else resolve()
    })
  })
}

// synthesize a whole text (auto-split into segments), pushing MP3 frames
export async function synthesizeAll(text, opts, onAudio) {
  const clean = removeIncompatibleChars(text)
  const escaped = xmlEscape(clean)
  const segments = splitTextByBytes(escaped, CHUNK_BYTES)
  if (!segments.length) return 0
  let bytes = 0
  for (const seg of segments) {
    await synthesizeSegment(seg, opts, (chunk) => { onAudio(chunk); bytes += chunk.length })
  }
  return bytes
}

// ── HTTP handler (Cloud Function entry) ────────────────────────────────────

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS })
  }
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } })
  }

  let data
  try { data = await request.json() } catch { return jsonErr('bad json', 400) }
  const text = String(data.text || '')
  if (!text) return jsonErr('empty text', 400)
  const voice = VOICE_MAP[data.voice] || data.voice || 'ja-JP-NanamiNeural'
  const opts = {
    voice,
    rate: String(data.rate || '+0%'),
    pitch: String(data.pitch || '+0Hz'),
  }

  // stream MP3 chunks as they are synthesised — the browser plays while
  // synthesis is still running (same behaviour as the local server.js)
  const stream = new ReadableStream({
    async start(controller) {
      try {
        await synthesizeAll(text, opts, (chunk) => {
          try { controller.enqueue(chunk) } catch { /* client gone */ }
        })
        try { controller.close() } catch { /* ignore */ }
      } catch (e) {
        try { controller.error(e) } catch { /* ignore */ }
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-cache', ...CORS },
  })
}

function jsonErr(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } })
}
