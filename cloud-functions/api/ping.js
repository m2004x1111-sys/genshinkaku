/* EdgeOne Makers Cloud Function — GET /api/ping
   前端 relay.js 的 detectRelay() 会请求同源 api/ping，
   返回纯文本 "ok" 即视为中转后端可用（relayMode=true），
   之后所有 TTS 请求自动改走 /api/tts，任何浏览器都能播放。
   部署：此文件位于 cloud-functions/api/ping.js，随项目一起发布即可。 */
export function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' },
    })
  }
  return new Response('ok', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
