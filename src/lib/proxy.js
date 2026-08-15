import { CONFIG } from './config.js'
import { detectRelay, relayUrl } from './relay.js'

/* fetch through CORS proxies (kakuyomu sends no CORS headers) */
export const ProxyUtil = (() => {
  function getIndex() {
    const v = parseInt(localStorage.getItem(CONFIG.LS_PROXY_INDEX), 10)
    return Number.isInteger(v) && CONFIG.PROXY_SERVERS[v] ? v : CONFIG.DEFAULT_PROXY_INDEX
  }
  function setIndex(i) {
    localStorage.setItem(CONFIG.LS_PROXY_INDEX, String(i))
  }
  function getCustom() {
    return localStorage.getItem(CONFIG.LS_PROXY_CUSTOM) || ''
  }
  function setCustom(tpl) {
    localStorage.setItem(CONFIG.LS_PROXY_CUSTOM, tpl || '')
  }
  function wrapFromTemplate(tpl, url) {
    if (tpl.includes('{url}')) return tpl.replace('{url}', encodeURIComponent(url))
    return tpl + encodeURIComponent(url)
  }
  // returns [{ template, headers }]; custom proxy first, then the chain
  function candidates() {
    const sel = CONFIG.PROXY_SERVERS[getIndex()]
    const custom = getCustom().trim()
    const list = []
    if (custom) list.push({ template: custom, headers: {} })
    if (sel) list.push(sel)
    for (const p of CONFIG.PROXY_SERVERS) {
      if (p.template !== sel.template && !list.some((c) => c.template === p.template)) list.push(p)
    }
    return list
  }
  // turn raw fetch errors into user-friendly messages
  function friendly(e, tpl) {
    const via = tpl ? ` (via ${tpl.split('/')[2]})` : ''
    if (e && e.name === 'AbortError') return `代理响应超时${via}`
    if (e && e.name === 'TypeError' && /Failed to fetch/i.test(e.message)) return `代理连接失败${via}`
    return (e && e.message) ? e.message + via : '未知错误'
  }

  async function text(url, { timeout = CONFIG.REQUEST_TIMEOUT_MS, onRetry, expect } = {}) {
    let lastErr = null
    // 1) local relay server (same-origin, no CORS, no free proxy)
    if (await detectRelay()) {
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), timeout)
        const res = await fetch(relayUrl('api/proxy?url=' + encodeURIComponent(url)), {
          signal: ctrl.signal,
          cache: 'no-store',
        })
        clearTimeout(timer)
        if (res.ok) {
          const txt = await res.text()
          if (txt && (!expect || expect.test(txt))) return txt
        }
        lastErr = new Error('relay proxy 失败')
      } catch (e) {
        lastErr = e
      }
      // fall through to public proxies on relay failure
    }
    const attempts = Math.max(1, CONFIG.PROXY_ATTEMPTS || 1)
    const delay = CONFIG.PROXY_RETRY_DELAY_MS || 0
    for (const cfg of candidates()) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const target = wrapFromTemplate(cfg.template, url)
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), timeout)
          const res = await fetch(target, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: cfg.headers || {},
          })
          clearTimeout(timer)
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status} (via ${cfg.template.split('/')[2]})`)
            if (onRetry) onRetry(lastErr.message)
            if (res.status >= 500) continue // transient — retry same proxy
            break // deterministic — next proxy
          }
          const txt = await res.text()
          if (!txt) {
            lastErr = new Error(`empty response (via ${cfg.template.split('/')[2]})`)
            if (onRetry) onRetry(lastErr.message)
            continue
          }
          // content sanity check: proxy may return 200 with an error page
          if (expect && !expect.test(txt)) {
            lastErr = new Error(`内容无效 (via ${cfg.template.split('/')[2]})`)
            if (onRetry) onRetry(lastErr.message)
            continue
          }
          return txt
        } catch (e) {
          lastErr = e
          if (onRetry) onRetry(friendly(e, cfg.template))
        }
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr ? new Error(friendly(lastErr)) : new Error('所有代理均不可用')
  }
  async function testProxy(tpl, headers = {}) {
    const target = wrapFromTemplate(tpl, 'https://kakuyomu.jp/')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: 'follow', headers })
      clearTimeout(timer)
      return { ok: res.ok, status: res.status, len: (await res.text()).length }
    } catch (e) {
      clearTimeout(timer)
      return { ok: false, error: e.message }
    }
  }
  return { getIndex, setIndex, getCustom, setCustom, candidates, text, testProxy, friendly }
})()
