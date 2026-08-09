import { ProxyUtil } from './proxy.js'
import { Util } from './util.js'

/* Kakuyomu scraper: parse __NEXT_DATA__ Apollo state into a chapter tree. */
export const Kakuyomu = (() => {
  const WORK_URL = (id) => `https://kakuyomu.jp/works/${id}`
  const EPISODE_URL = (wid, eid) => `https://kakuyomu.jp/works/${wid}/episodes/${eid}`

  const _NEXT_DATA_RE = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/

  function parseWorkId(text) {
    const m = String(text).match(/works\/(\d+)/)
    return m ? m[1] : String(text).trim()
  }

  function parseNextData(html) {
    const m = html.match(_NEXT_DATA_RE)
    if (!m) throw new Error('__NEXT_DATA__ not found — 作品ID无效或页面结构已变更')
    return JSON.parse(m[1])
  }

  function parseState(workId, state) {
    let resolvedId = workId
    const rq = state.ROOT_QUERY || {}
    for (const key of Object.keys(rq)) {
      if (key.startsWith('Work(')) {
        try {
          const inner = key.slice('Work('.length, -1)
          resolvedId = JSON.parse(inner).id || workId
        } catch (e) { /* keep workId */ }
        break
      }
    }
    const workData = state[`Work:${resolvedId}`]
    if (!workData) throw new Error('Work 未在页面数据中找到')

    const meta = {
      workId: resolvedId,
      title: workData.title || '',
      catchphrase: workData.catchphrase || '',
      introduction: workData.introduction || '',
      tags: workData.tagLabels || [],
      author: '',
    }
    const authorRef = workData.author && workData.author.__ref
    if (authorRef && state[authorRef]) {
      meta.author = state[authorRef].activityName || ''
    }
    const root = buildTree(resolvedId, meta.title, state)
    return { meta, root }
  }

  function chapterRefs(workData) {
    if (workData.tableOfContentsV2) {
      return workData.tableOfContentsV2.map((i) => i.__ref)
    }
    const refs = []
    for (const table of workData.tableOfContents || []) {
      refs.push(...Object.values(table))
    }
    return refs
  }

  function buildTree(workId, workTitle, state) {
    const workData = state[`Work:${workId}`]
    const refs = chapterRefs(workData)
    const root = { title: workTitle, level: 0, children: [], episodes: [] }

    const flatRef = refs.includes('TableOfContentsChapter:') ? 'TableOfContentsChapter:' : null
    const treeRefs = refs.filter((r) => r !== 'TableOfContentsChapter:')
    if (flatRef) attachEpisodes(root, state, flatRef, workId)

    const chapters = []
    for (const ref of treeRefs) {
      const tocEntry = state[ref] || {}
      const chapterRef = (tocEntry.chapter || {}).__ref
      const chap = state[chapterRef] || tocEntry
      chapters.push({
        level: parseInt(chap.level, 10) || 1,
        title: chap.title || '',
        id: String(chap.id || ref),
        ref,
      })
    }

    if (chapters.length) {
      const stack = [root]
      for (const c of chapters) {
        const node = { title: c.title, level: c.level, children: [], episodes: [] }
        while (stack.length && stack[stack.length - 1].level >= c.level) stack.pop()
        if (!stack.length) stack = [root]
        stack[stack.length - 1].children.push(node)
        stack.push(node)
        attachEpisodes(node, state, c.ref, workId)
      }
    }
    return root
  }

  function attachEpisodes(node, state, tocRef, workId) {
    for (const item of (state[tocRef] || {}).episodeUnions || []) {
      const epId = String(item.__ref.split(':').pop())
      const epData = state[`Episode:${epId}`] || {}
      node.episodes.push({ workId, episodeId: epId, title: epData.title || '' })
    }
  }

  function walk(node, path, out) {
    if (!out) out = []
    if (!path) path = []
    for (const ep of node.episodes) out.push({ ...ep, chapterPath: [...path] })
    for (const child of node.children) walk(child, path.concat(child.title), out)
    return out
  }

  // ── episode body ──────────────────────────────────────────────────────────
  function extractParagraphs(pageHtml) {
    const doc = new DOMParser().parseFromString(pageHtml, 'text/html')
    const main = doc.getElementById('contentMain-inner')
    if (!main) throw new Error('contentMain-inner 未找到 — 页面结构可能已变更')
    const ps = Array.from(main.querySelectorAll('p'))
    return ps.slice(1).map((p) => p.outerHTML)
  }

  function paragraphsToText(paragraphs) {
    const parts = []
    for (const p of paragraphs) {
      const div = document.createElement('div')
      div.innerHTML = p
      div.querySelectorAll('rt, rp').forEach((n) => n.remove())
      const t = div.textContent.trim()
      if (t) parts.push(t)
    }
    return parts.join('\n\n')
  }

  // ── high level ────────────────────────────────────────────────────────────
  async function fetchWork(workId, { onRetry } = {}) {
    const html = await ProxyUtil.text(WORK_URL(workId), { onRetry })
    const data = parseNextData(html)
    const state = data.props && data.props.pageProps && data.props.pageProps.__APOLLO_STATE__
    if (!state) throw new Error('__APOLLO_STATE__ 未找到 — 页面结构可能已变更')
    return parseState(workId, state)
  }

  async function fetchEpisode(workId, episodeId, { onRetry } = {}) {
    const html = await ProxyUtil.text(EPISODE_URL(workId, episodeId), { onRetry })
    return extractParagraphs(html)
  }

  return {
    WORK_URL, EPISODE_URL,
    parseWorkId, parseNextData, parseState, buildTree, walk,
    extractParagraphs, paragraphsToText,
    fetchWork, fetchEpisode,
  }
})()
