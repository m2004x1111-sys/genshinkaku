/* EdgeOne Makers Cloud Function — GET /api/proxy
   Server-side Kakuyomu fetch so the frontend does not depend on public CORS proxies.
   Keep the target allowlist narrow: this endpoint is not a general-purpose proxy. */

const EDGE_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const ALLOWED_HOSTS = new Set(['kakuyomu.jp', 'www.kakuyomu.jp'])
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (request.method !== 'GET') return jsonError('method not allowed', 405)

  const target = new URL(request.url).searchParams.get('url')
  if (!target) return jsonError('missing url', 400)

  let targetUrl
  try { targetUrl = new URL(target) } catch { return jsonError('invalid url', 400) }
  if (targetUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(targetUrl.hostname)) {
    return jsonError('only kakuyomu.jp URLs are allowed', 400)
  }

  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': EDGE_UA,
        'Accept-Language': 'ja,en;q=0.8',
      },
      signal: AbortSignal.timeout(30000),
    })
    const body = await response.arrayBuffer()
    return new Response(body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        ...CORS,
      },
    })
  } catch (e) {
    return jsonError(String(e && e.message || e), 502)
  }
}

function jsonError(error, status) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS },
  })
}
