/* 本地模拟 EdgeOne 平台调用云函数（onRequest + 标准 Request/Response），
   验证 /api/ping 与 /api/tts 在真实 HTTP 请求下工作正常 */
import http from 'node:http'
import { onRequest as pingOnRequest } from './cloud-functions/api/ping.js'
import { onRequest as ttsOnRequest } from './cloud-functions/api/tts.js'

const server = http.createServer(async (req, res) => {
  // 读取原始 body
  const chunks = []
  for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const url = new URL(req.url, 'http://localhost')
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k] = String(v)
  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
  })
  const handler = url.pathname === '/api/ping' ? pingOnRequest : url.pathname === '/api/tts' ? ttsOnRequest : null
  if (!handler) { res.writeHead(404); res.end('not found'); return }
  let resp
  try {
    resp = await handler({ request })
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' })
    res.end('handler error: ' + e.message)
    return
  }
  res.writeHead(resp.status, Object.fromEntries(resp.headers.entries()))
  if (resp.body) {
    const reader = resp.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        res.write(value)
      }
    } catch { /* stream aborted */ }
  }
  res.end()
})

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port
  const base = `http://127.0.0.1:${port}`

  // 1) ping
  const p = await fetch(`${base}/api/ping`)
  console.log('PING  ->', p.status, JSON.stringify(await p.text()))

  // 2) tts（短文本，流式读取计数）
  const t0 = Date.now()
  const r = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'こんにちは、これはクラウド関数のテストです。', voice: 'nanami', rate: '+0%', pitch: '+0Hz' }),
  })
  console.log('TTS   -> status', r.status, 'type', r.headers.get('content-type'))
  const reader = r.body.getReader()
  let bytes = 0
  let firstChunkMs = null
  const t1 = Date.now()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value && value.length) {
      if (firstChunkMs === null) firstChunkMs = Date.now() - t1
      bytes += value.length
    }
  }
  console.log(`TTS   -> total ${bytes} bytes, 首块 ${firstChunkMs}ms, 总耗时 ${Date.now() - t0}ms`)

  // 3) 空文本报错
  const bad = await fetch(`${base}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '', voice: 'nanami' }),
  })
  console.log('BAD   ->', bad.status, await bad.text())

  server.close()
  process.exit(0)
})
