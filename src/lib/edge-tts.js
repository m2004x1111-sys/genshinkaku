import { Util } from './util.js'
import { EDGE_TTS_TOKEN, CONFIG } from './config.js'
import { detectRelay } from './relay.js'

/* browser-side Microsoft Edge TTS client over WebSocket */
export const EdgeTTS = (() => {
  const WSS_URL =
    `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/` +
    `edge/v1?TrustedClientToken=${EDGE_TTS_TOKEN}`
  const SEC_MS_GEC_VERSION = '1-143.0.3650.75'

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

  function parseBinaryFrame(data) {
    if (data.length < 2) return null
    const hl = (data[0] << 8) | data[1]
    if (2 + hl > data.length) return null
    const head = Util.decoder.decode(data.subarray(2, 2 + hl))
    const headers = parseTextHeaders(head)
    const payload = data.subarray(2 + hl)
    return { headers, payload }
  }

  async function* iterateWs(ws) {
    const queue = []
    let waiter = null
    let ended = false
    ws.onmessage = (ev) => {
      if (waiter) { const w = waiter; waiter = null; w.resolve(ev) }
      else queue.push(ev)
    }
    ws.onclose = () => { ended = true; if (waiter) { const w = waiter; waiter = null; w.resolve(null) } }
    ws.onerror = () => { ended = true; if (waiter) { const w = waiter; waiter = null; w.reject(new Error('websocket error')) } }
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift()
      else if (!ended) yield await new Promise((resolve, reject) => { waiter = { resolve, reject } })
      else break
    }
  }

  async function* synthesizeSegment(text, opts) {
    const connId = Util.hexUUID()
    const token = Util.generateSecMsGec(Date.now())
    const url = `${WSS_URL}&ConnectionId=${connId}&Sec-MS-GEC=${token}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'

    await new Promise((resolve, reject) => {
      ws.onopen = resolve
      ws.onerror = () => reject(new Error('连接语音服务失败'))
    })
    ws.onerror = null

    ws.send(speechConfigMessage())
    ws.send(ssmlMessage(text, opts))

    let audioReceived = false
    for await (const ev of iterateWs(ws)) {
      if (!ev) break
      if (typeof ev.data === 'string') {
        const headers = parseTextHeaders(ev.data)
        if (headers.Path === 'turn.end') break
      } else {
        const frame = parseBinaryFrame(new Uint8Array(ev.data))
        if (!frame) continue
        if (frame.headers.Path === 'audio' && frame.headers['Content-Type'] === 'audio/mpeg') {
          audioReceived = true
          yield frame.payload
        }
      }
    }
    try { ws.close() } catch (e) { /* ignore */ }
    if (!audioReceived) throw new Error('未收到音频 — 参数或连接可能有问题')
  }

  // ── relay mode: server.js synthesizes with the correct User-Agent, so
  //    MP3 works in every browser (including mobile). The server streams
  //    the whole MP3; we yield raw response chunks for MSE / blob. ─────────
  async function* relayStream(text, opts = {}) {
    const res = await fetch('api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        voice: opts.voice,
        rate: opts.rate || '+0%',
        pitch: opts.pitch || '+0Hz',
      }),
    })
    if (!res.ok || !res.body) {
      throw new Error(`本地中转换音失败（HTTP ${res.status}）`)
    }
    const reader = res.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) yield value
      }
    } finally {
      reader.releaseLock()
    }
  }

  async function* stream(text, opts = {}) {
    if (await detectRelay()) {
      yield* relayStream(text, opts)
      return
    }
    const clean = Util.removeIncompatibleChars(text)
    const escaped = Util.xmlEscape(clean)
    const segments = Util.splitTextByBytes(escaped, CONFIG.TTS_CHUNK_BYTES)
    if (!segments.length) return
    for (const seg of segments) {
      yield* synthesizeSegment(seg, opts)
    }
  }

  async function synthBlob(text, opts = {}, onProgress) {
    const parts = []
    let total = 0
    for await (const chunk of stream(text, opts)) {
      parts.push(chunk)
      total += chunk.length
      if (onProgress) onProgress(total)
    }
    return new Blob(parts, { type: 'audio/mpeg' })
  }

  function voiceName(voice) {
    return CONFIG.VOICE_MAP[voice] || voice
  }

  return { stream, synthBlob, voiceName, WSS_URL, SEC_MS_GEC_VERSION, dateToStr }
})()
