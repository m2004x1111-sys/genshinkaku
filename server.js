/* kakuyomub2-genshin — local relay server.
   用途：
     1. 静态托管 dist/ 构建产物（浏览器直接访问）
     2. /api/proxy   —— 服务器端直连 kakuyomu 抓取（无 CORS、不依赖免费公共代理）
     3. /api/tts     —— 服务器端以正确 User-Agent 连接微软 edge-tts，把 MP3 流式返回
                        （任何浏览器/手机都能播放和导出 MP3，不再受浏览器 UA 限制）

   启动：npm run build 后执行  node server.js
         （或双击 启动网页.bat）
   移动端同网访问：http://<本机局域网IP>:5174
*/
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Util } from './src/lib/util.js'
import { EDGE_TTS_TOKEN, CONFIG } from './src/lib/config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(__dirname, 'dist')
const PORT = Number(process.env.PORT || 5174)
const HOST = process.env.HOST || '0.0.0.0'

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const WSS_URL =
  `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/` +
  `edge/v1?TrustedClientToken=${EDGE_TTS_TOKEN}`
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'

const VOICE_MAP = {
  nanami: 'ja-JP-NanamiNeural',
  keita: 'ja-JP-KeitaNeural',
}

// ── edge-tts helpers ────────────────────────────────────────────────────────
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
    `X-RequestId:${Util.hexUUID()}\r\n` +
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

// synthesize one text segment, pushing MP3 frames to onAudio
function synthesizeSegment(text, opts, onAudio) {
  return new Promise((resolve, reject) => {
    const connId = Util.hexUUID()
    const token = Util.generateSecMsGec(Date.now())
    const url = `${WSS_URL}&ConnectionId=${connId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
    let ws
    try {
      ws = new WebSocket(url, {
        headers: {
          'User-Agent': EDGE_UA,
          Origin: ORIGIN,
          Pragma: 'no-cache',
          'Cache-Control': 'no-cache',
          Cookie: `muid=${Util.hexUUID().toUpperCase()};`,
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

async function synthesizeAll(text, opts, onAudio) {
  const clean = Util.removeIncompatibleChars(text)
  const escaped = Util.xmlEscape(clean)
  const segments = Util.splitTextByBytes(escaped, CONFIG.TTS_CHUNK_BYTES)
  if (!segments.length) return
  for (const seg of segments) {
    await synthesizeSegment(seg, opts, onAudio)
  }
}

// ── HTTP handlers ───────────────────────────────────────────────────────────
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

async function handleProxy(req, res, params) {
  const target = params.get('url')
  if (!target) return sendJSON(res, 400, { error: 'missing url' })
  try {
    const r = await fetch(target, {
      redirect: 'follow',
      headers: {
        'User-Agent': EDGE_UA,
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(30000),
    })
    const body = Buffer.from(await r.arrayBuffer())
    const type = r.headers.get('content-type') || 'text/html; charset=utf-8'
    res.writeHead(r.status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
    res.end(body)
  } catch (e) {
    sendJSON(res, 502, { error: String(e && e.message || e) })
  }
}

function handleTTS(req, res) {
  let body = ''
  req.on('data', (c) => {
    body += c
    if (body.length > 2_000_000) { req.destroy() }
  })
  req.on('end', async () => {
    let data
    try { data = JSON.parse(body) } catch { return sendJSON(res, 400, { error: 'bad json' }) }
    const text = String(data.text || '')
    if (!text) return sendJSON(res, 400, { error: 'empty text' })
    const voice = VOICE_MAP[data.voice] || data.voice || 'ja-JP-NanamiNeural'
    const opts = {
      voice,
      rate: String(data.rate || '+0%'),
      pitch: String(data.pitch || '+0Hz'),
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache',
      'Transfer-Encoding': 'chunked',
    })
    try {
      await synthesizeAll(text, opts, (chunk) => { try { res.write(chunk) } catch {} })
      try { res.end() } catch {}
    } catch (e) {
      try { res.end() } catch {}
    }
  })
  req.on('error', () => { try { res.end() } catch {} })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
}

function serveStatic(res, pathname) {
  let p = path.normalize(path.join(DIST, pathname))
  if (!p.startsWith(DIST)) { res.writeHead(403); res.end('forbidden'); return }
  if (pathname === '/' || pathname.startsWith('/index.html') || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    p = path.join(DIST, 'index.html')
  }
  if (!fs.existsSync(p)) { res.writeHead(404); res.end('not found'); return }
  const ext = path.extname(p).toLowerCase()
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })
  fs.createReadStream(p).pipe(res)
}

// ── server ─────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let pathname, params
  try {
    const u = new URL(req.url, 'http://localhost')
    pathname = decodeURIComponent(u.pathname)
    params = u.searchParams
  } catch {
    res.writeHead(400); res.end('bad request'); return
  }

  if (pathname === '/api/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' })
    res.end('ok')
    return
  }
  if (pathname === '/api/proxy') { handleProxy(req, res, params); return }
  if (pathname === '/api/tts') { handleTTS(req, res); return }
  serveStatic(res, pathname)
})

server.listen(PORT, HOST, () => {
  console.log(`\n  カクヨム TTS（本地中转模式）`)
  console.log(`  本机:    http://localhost:${PORT}`)
  console.log(`  局域网:  http://<本机IP>:${PORT}（手机同网可访问）\n`)
})
