/* detect whether the app is served by the local relay server (server.js).
   When true, fetching goes through /api/proxy and TTS through /api/tts,
   so no CORS proxy is needed and MP3 works in every browser. */
let active = false
let checking = null

export function isRelay() {
  return active
}

export function detectRelay() {
  if (checking) return checking
  checking = (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 3000)
      const r = await fetch('api/ping', { signal: ctrl.signal, cache: 'no-store' })
      clearTimeout(timer)
      active = r.ok && (await r.text()) === 'ok'
    } catch (e) {
      active = false
    }
    return active
  })()
  return checking
}
