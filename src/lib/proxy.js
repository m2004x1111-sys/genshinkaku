import { CONFIG } from './config.js'

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
  function candidates() {
    const sel = CONFIG.PROXY_SERVERS[getIndex()]
    const custom = getCustom().trim()
    const pool = []
    if (custom) pool.push(custom)
    if (sel) pool.push(sel.template)
    for (const p of CONFIG.PROXY_SERVERS) {
      if (p.template !== sel.template && !pool.includes(p.template)) pool.push(p.template)
    }
    return pool
  }
  // turn raw fetch errors into user-friendly messages
  function friendly(e, tpl) {
    const via = tpl ? ` (via ${tpl.split('/')[2]})` : ''
    if (e && e.name === 'AbortError') return `代理响应超时${via}`
    if (e && e.name === 'TypeError' && /Failed to fetch/i.test(e.message)) return `代理连接失败${via}`
    return (e && e.message) ? e.message + via : '未知错误'
  }

  async function text(url, { timeout = CONFIG.REQUEST_TIMEOUT_MS, onRetry } = {}) {
    let lastErr = null
    const attempts = Math.max(1, CONFIG.PROXY_ATTEMPTS || 1)
    const delay = CONFIG.PROXY_RETRY_DELAY_MS || 0
    for (const tpl of candidates()) {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        const target = wrapFromTemplate(tpl, url)
        try {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), timeout)
          const res = await fetch(target, { signal: ctrl.signal, redirect: 'follow' })
          clearTimeout(timer)
          if (!res.ok) {
            lastErr = new Error(`HTTP ${res.status} (via ${tpl.split('/')[2]})`)
            if (onRetry) onRetry(lastErr.message)
            if (res.status >= 500) continue // transient — retry same proxy
            break // deterministic — next proxy
          }
          const txt = await res.text()
          if (!txt) {
            lastErr = new Error(`empty response (via ${tpl.split('/')[2]})`)
            if (onRetry) onRetry(lastErr.message)
            continue
          }
          return txt
        } catch (e) {
          lastErr = e
          if (onRetry) onRetry(friendly(e, tpl))
        }
        if (attempt < attempts) {
          await new Promise((r) => setTimeout(r, delay))
        }
      }
    }
    throw lastErr ? new Error(friendly(lastErr)) : new Error('所有代理均不可用')
  }
  async function testProxy(tpl) {
    const target = wrapFromTemplate(tpl, 'https://kakuyomu.jp/')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(target, { signal: ctrl.signal, redirect: 'follow' })
      clearTimeout(timer)
      return { ok: res.ok, status: res.status, len: (await res.text()).length }
    } catch (e) {
      clearTimeout(timer)
      return { ok: false, error: e.message }
    }
  }
  return { getIndex, setIndex, getCustom, setCustom, candidates, text, testProxy }
})()
