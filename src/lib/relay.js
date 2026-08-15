/* detect whether the app has a relay backend available.
   Two sources:
     1. same-origin: the app is served by server.js itself (local relay)
     2. remote base: a separately deployed server.js, set in app settings
   When relay is active, fetching goes through /api/proxy and TTS through
   /api/tts, so no CORS proxy is needed and MP3 works in every browser. */
const LS_RELAY_BASE = 'kakuyomu_relay_base'
let localActive = false
let checking = null

export function getRelayBase() {
  try {
    return (localStorage.getItem(LS_RELAY_BASE) || '').trim().replace(/\/+$/, '')
  } catch (e) {
    return ''
  }
}
export function setRelayBase(v) {
  try { localStorage.setItem(LS_RELAY_BASE, (v || '').trim()) } catch (e) { /* ignore */ }
  checking = null
  localActive = false
}
export function isRelay() {
  return localActive
}
// full URL for a relay API path (same-origin or remote base)
export function relayUrl(path) {
  const base = getRelayBase()
  return base ? base + '/' + path.replace(/^\//, '') : path
}
export function detectRelay() {
  if (checking) return checking
  checking = (async () => {
    const ping = async (url) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      try {
        const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' })
        clearTimeout(timer)
        return r.ok && (await r.text()) === 'ok'
      } catch (e) {
        clearTimeout(timer)
        return false
      }
    }
    const base = getRelayBase()
    if (base) {
      localActive = await ping(base + '/api/ping')
      return localActive
    }
    localActive = await ping('api/ping')
    return localActive
  })()
  return checking
}
