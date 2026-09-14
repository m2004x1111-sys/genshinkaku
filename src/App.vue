<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { Message } from '@shi-zhong/genshin-ui'
import ChapterNode from './components/ChapterNode.vue'
import { CONFIG } from './lib/config'
import { Util } from './lib/util'
import { ProxyUtil } from './lib/proxy'
import { Cache } from './lib/storage'
import { Kakuyomu } from './lib/kakuyomu'
import { EdgeTTS } from './lib/edge-tts'
import { Zip } from './lib/zip'
import { Epub } from './lib/epub'
import { Player } from './lib/player'
import { isRelay, detectRelay, getRelayBase, setRelayBase } from './lib/relay.js'

// ── state ──────────────────────────────────────────────────────────────
const workIdInput = ref('')
const work = ref(null)
const entries = ref([])
const episodeParas = ref(new Map())
const currentText = ref('')
const current = ref(null) // {episode, index}
const voice = ref('nanami')
const rate = ref('+0%')
const pitch = ref('+0Hz')
const pbRate = ref('1')
const volume = ref(1)
const saveToLocal = ref(false)
const autoNext = ref(true)
const busy = ref(false)
const loading = ref(false)
const loadingText = ref('')
const status = ref('')
const isPlaying = ref(false)
const curTime = ref(0)
const duration = ref(NaN)

const batchRunning = ref(false)
const batchProgress = ref(0)
const batchStatus = ref('')

const settingsOpen = ref(false)
const proxyIdx = ref('0')
const proxyCustom = ref('')
const proxyTestResult = ref('')
const relayBase = ref('')

const relayMode = ref(false)
const page = ref('parse')
const chaptersOpen = ref(false)
const audioControlsOpen = ref(false)
const moreOpen = ref(false)
const isEdge = computed(() => relayMode.value || Util.isEdgeTTSBrowser())
const AUDIO_SETTINGS_KEY = 'kakuyomu_audio_settings'
const LAST_WORK_INPUT_KEY = 'kakuyomu_last_work_input'
const LAST_READING_POSITION_KEY = 'kakuyomu_last_reading_position'
let restoreRequestId = 0
const modeLabel = computed(() => {
  if (isEdge.value) {
    if (relayMode.value) return getRelayBase() ? '远程中转 · 全浏览器可放 MP3' : '喵！'
    return 'Edge TTS · 可导出 MP3'
  }
  return '浏览器语音 · 无 MP3'
})

const indexMap = computed(() => {
  const m = {}
  entries.value.forEach((e, i) => { m[e.episodeId] = i + 1 })
  return m
})
const activeId = computed(() => (current.value ? current.value.episode.episodeId : ''))

const voiceOptions = [
  { text: 'Nanami（女声）', value: 'nanami' },
  { text: 'Keita（男声）', value: 'keita' },
]
const rateOptions = CONFIG.RATES.map((r) => ({ text: r, value: r }))
const pitchOptions = CONFIG.PITCHES.map((p) => ({ text: p, value: p }))
const pbRateOptions = [
  { text: '0.5x', value: '0.5' },
  { text: '0.75x', value: '0.75' },
  { text: '1.0x', value: '1' },
  { text: '1.25x', value: '1.25' },
  { text: '1.5x', value: '1.5' },
  { text: '2.0x', value: '2' },
]
const proxyOptions = [
  { text: 'r.jina.ai（推荐）', value: '0' },
  { text: 'allorigins.win', value: '1' },
  { text: 'corsproxy.io', value: '2' },
  { text: '自定义代理', value: 'custom' },
]

function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '…'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function openParsePage() {
  Player.stop()
  chaptersOpen.value = false
  audioControlsOpen.value = false
  moreOpen.value = false
  page.value = 'parse'
}

function toggleAudioControls() {
  audioControlsOpen.value = !audioControlsOpen.value
  moreOpen.value = false
}

function toggleMoreMenu() {
  moreOpen.value = !moreOpen.value
  audioControlsOpen.value = false
}

// ── episode content ────────────────────────────────────────────────────
async function ensureParagraphs(entry) {
  if (episodeParas.value.has(entry.episodeId)) return episodeParas.value.get(entry.episodeId)
  const cached = await Cache.get(entry.episodeId, 'episodes')
  if (cached && Array.isArray(cached.paragraphs)) {
    episodeParas.value.set(entry.episodeId, cached.paragraphs)
    return cached.paragraphs
  }
  const paras = await Kakuyomu.fetchEpisode(entry.workId, entry.episodeId, {
    onRetry: (m) => { status.value = `抓取失败重试中: ${m}` },
  })
  episodeParas.value.set(entry.episodeId, paras)
  Cache.set(entry.episodeId, { paragraphs: paras, fetchedAt: Date.now() }, 'episodes')
  return paras
}
async function episodeText(entry) {
  const paras = await ensureParagraphs(entry)
  return Kakuyomu.paragraphsToText(paras)
}

async function mapConcurrent(list, worker, limit) {
  const results = new Array(list.length)
  let next = 0
  async function runner() {
    while (next < list.length) {
      const i = next++
      results[i] = await worker(list[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, runner))
  return results
}
async function fetchAllParagraphs(onProgress) {
  await mapConcurrent(entries.value, async (entry, i) => {
    await ensureParagraphs(entry)
    if (onProgress) onProgress(i + 1, entries.value.length)
  }, 4)
}

// ── load work ──────────────────────────────────────────────────────────
function applyWork(data) {
  work.value = data
  entries.value = Kakuyomu.walk(data.root)
  current.value = null
  currentText.value = ''
  episodeParas.value = new Map()
  status.value = ''
  chaptersOpen.value = false
  page.value = 'reader'
  void restoreLastReadingPosition()
}

function saveLastWorkInput(input) {
  try {
    localStorage.setItem(LAST_WORK_INPUT_KEY, input)
  } catch (e) { /* ignore unavailable browser storage */ }
}

function saveReadingPosition(ep) {
  try {
    localStorage.setItem(LAST_READING_POSITION_KEY, JSON.stringify({
      workId: String(ep.workId),
      episodeId: String(ep.episodeId),
    }))
  } catch (e) { /* ignore unavailable browser storage */ }
}

async function restoreLastReadingPosition() {
  const requestId = ++restoreRequestId
  let saved
  try {
    saved = JSON.parse(localStorage.getItem(LAST_READING_POSITION_KEY) || 'null')
  } catch (e) { return }
  if (!saved || String(saved.workId) !== String(work.value?.meta.workId)) return

  const entry = entries.value.find((item) => String(item.episodeId) === String(saved.episodeId))
  if (!entry) return

  current.value = { episode: entry, index: indexMap.value[entry.episodeId] }
  status.value = '正在恢复上次阅读位置...'
  try {
    const text = await episodeText(entry)
    if (requestId !== restoreRequestId || current.value?.episode.episodeId !== entry.episodeId) return
    currentText.value = text
    status.value = text ? '已恢复上次阅读位置' : '正文为空 — 可能抓取失败'
  } catch (e) {
    if (requestId === restoreRequestId) status.value = '恢复正文失败：' + e.message
  }
}

function loadAudioSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUDIO_SETTINGS_KEY) || 'null')
    if (!saved) return
    if (['nanami', 'keita'].includes(saved.voice)) voice.value = saved.voice
    if (CONFIG.RATES.includes(saved.rate)) rate.value = saved.rate
    if (CONFIG.PITCHES.includes(saved.pitch)) pitch.value = saved.pitch
    if (['0.5', '0.75', '1', '1.25', '1.5', '2'].includes(String(saved.pbRate))) pbRate.value = String(saved.pbRate)
    if (Number.isFinite(saved.volume)) volume.value = Math.min(1, Math.max(0, Number(saved.volume)))
    if (typeof saved.autoNext === 'boolean') autoNext.value = saved.autoNext
    if (typeof saved.saveToLocal === 'boolean') saveToLocal.value = saved.saveToLocal
    Player.audio.volume = volume.value
    Player.audio.playbackRate = parseFloat(pbRate.value)
  } catch (e) { /* ignore malformed local settings */ }
}

function saveAudioSettings() {
  try {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({
      voice: voice.value,
      rate: rate.value,
      pitch: pitch.value,
      pbRate: pbRate.value,
      volume: volume.value,
      autoNext: autoNext.value,
      saveToLocal: saveToLocal.value,
    }))
  } catch (e) { /* ignore storage failures */ }
}

async function loadWork() {
  const input = workIdInput.value.trim()
  if (!input) { Message.error('请输入作品 ID 或 URL'); return }
  const wid = Kakuyomu.parseWorkId(input)

  // cache-first: show cached work immediately, refresh in background
  const cached = await Cache.get(wid, 'works')
  if (cached && cached.work) {
    saveLastWorkInput(input)
    applyWork(cached.work)
    loading.value = true
    loadingText.value = '已加载缓存，正在后台刷新...'
    busy.value = true
    try {
      const fresh = await Kakuyomu.fetchWork(wid, { onRetry: (m) => { loadingText.value = `刷新失败重试中: ${m}` } })
      Cache.set(wid, { work: fresh }, 'works')
      applyWork(fresh)
      Message.success(`已更新：${fresh.meta.title}（${Kakuyomu.walk(fresh.root).length} 话）`)
    } catch (e) {
      Message.info('网络刷新失败，继续使用缓存')
    } finally {
      busy.value = false
      loading.value = false
    }
    return
  }

  // no cache — require the network
  loading.value = true
  loadingText.value = '正在获取作品信息...'
  busy.value = true
  try {
    const data = await Kakuyomu.fetchWork(wid, { onRetry: (m) => { loadingText.value = `抓取失败重试中: ${m}` } })
    Cache.set(wid, { work: data }, 'works')
    saveLastWorkInput(input)
    applyWork(data)
    Message.success(`读取成功：${data.meta.title}（${entries.value.length} 话）`)
  } catch (e) {
    Message.error('读取失败: ' + e.message)
  } finally {
    busy.value = false
    loading.value = false
  }
}

// ── select / play ──────────────────────────────────────────────────────
function selectEpisode(ep) {
  current.value = { episode: ep, index: indexMap.value[ep.episodeId] }
  saveReadingPosition(ep)
  chaptersOpen.value = false
  playEpisode()
}
function stepEpisode(delta) {
  if (!current.value || !entries.value.length) return
  const idx = current.value.index - 1 + delta
  if (idx < 0 || idx >= entries.value.length) return
  const entry = entries.value[idx]
  current.value = { episode: entry, index: idx + 1 }
  saveReadingPosition(entry)
  playEpisode()
}

async function playEpisode() {
  if (!current.value || !work.value) return
  const ep = current.value.episode
  Player.stop()
  currentText.value = ''
  curTime.value = 0
  duration.value = NaN
  status.value = '正在获取正文...'
  try {
    const text = await episodeText(ep)
    if (!text) { status.value = '正文为空 — 可能抓取失败'; return }
    currentText.value = text

    if (isEdge.value) {
      status.value = '正在合成语音...'
      busy.value = true
      try {
        const blob = await Player.play({
          text, voice: voice.value, rate: rate.value, pitch: pitch.value,
          save: saveToLocal.value, onStatus: () => {},
        })
        busy.value = false
        if (blob) {
          const fname = `${String(current.value.index).padStart(3, '0')}_${Util.cleanFilename(ep.title)}.mp3`
          Util.downloadBlob(blob, fname)
          status.value = '已保存: ' + fname
        } else {
          status.value = '播放中（在线流式）'
        }
        return
      } catch (e) {
        busy.value = false
        status.value = `MP3 语音服务失败：${e.message}；正在尝试浏览器语音`
      }
    }

    await Player.playSpeech({
      text, rate: rate.value, pitch: pitch.value,
      onStatus: (kind, msg) => {
        if (kind === 'speaking') { status.value = '正在播放（浏览器语音，无法导出 MP3）'; isPlaying.value = true }
        else if (kind === 'error') { status.value = msg; isPlaying.value = false }
        else if (kind === 'done') { status.value = '播放完成'; isPlaying.value = false }
      },
      onEnd: () => { if (autoNext.value) stepEpisode(1) },
    })
  } catch (e) {
    busy.value = false
    status.value = '合成失败: ' + e.message
  }
}

function togglePlay() {
  if (Player.mode === 'speech') {
    Player.toggleSpeech()
    isPlaying.value = !(window.speechSynthesis && speechSynthesis.paused)
    return
  }
  const audio = Player.audio
  if (!audio.src) return
  if (audio.paused) audio.play().catch(() => {}); else audio.pause()
}

function onSeek(e) {
  const audio = Player.audio
  if (audio.duration) audio.currentTime = parseFloat(e.target.value)
}
function onVolume(e) {
  volume.value = parseFloat(e.target.value)
  Player.audio.volume = volume.value
}

watch([voice, rate, pitch], () => {
  if (current.value) playEpisode()
})
watch(pbRate, (v) => { Player.audio.playbackRate = parseFloat(v) })
watch(saveToLocal, () => { if (current.value) playEpisode() })

// ── EPUB ───────────────────────────────────────────────────────────────
async function downloadEpub() {
  if (!work.value) return
  loading.value = true
  busy.value = true
  try {
    await fetchAllParagraphs((done, total) => { loadingText.value = `获取正文 ${done}/${total}...` })
    const blob = Epub.build(work.value, episodeParas.value)
    Util.downloadBlob(blob, `${Util.cleanFilename(work.value.meta.title)}.epub`)
    Message.success('EPUB 已下载')
  } catch (e) {
    Message.error('EPUB 生成失败: ' + e.message)
  } finally {
    busy.value = false
    loading.value = false
  }
}

// ── batch ──────────────────────────────────────────────────────────────
async function generateAll() {
  if (!isEdge.value) {
    Message.error('批量生成 MP3 需要 Microsoft Edge 143+（edge-tts）。其他浏览器只能浏览器语音播放。')
    return
  }
  if (!work.value || busy.value) return
  busy.value = true
  batchRunning.value = true
  batchProgress.value = 0
  batchStatus.value = '准备中...'
  const zipEntries = []
  const base = Util.cleanFilename(work.value.meta.title)
  try {
    batchStatus.value = '正在获取正文...'
    await fetchAllParagraphs((done, total) => {
      batchProgress.value = Math.round((done / total) * 100)
    })
    for (let i = 0; i < entries.value.length; i++) {
      const entry = entries.value[i]
      batchStatus.value = `[${i + 1}/${entries.value.length}] 合成中: ${entry.title}`
      try {
        const paras = episodeParas.value.get(entry.episodeId)
        const t = Kakuyomu.paragraphsToText(paras)
        if (!t) throw new Error('正文为空')
        const mp3 = await EdgeTTS.synthBlob(t, {
          voice: EdgeTTS.voiceName(voice.value), rate: rate.value, pitch: pitch.value,
        })
        const sub = entry.chapterPath.length ? entry.chapterPath.map(Util.cleanFilename).join('/') : ''
        const name = `${base}/${sub ? sub + '/' : ''}${String(i + 1).padStart(3, '0')}_${Util.cleanFilename(entry.title)}.mp3`
        zipEntries.push({ name, content: new Uint8Array(await mp3.arrayBuffer()) })
      } catch (e) {
        batchStatus.value = `[${i + 1}/${entries.value.length}] 失败: ${entry.title} — ${e.message}`
      }
      batchProgress.value = Math.round(((i + 1) / entries.value.length) * 100)
    }
    if (zipEntries.length) {
      const blob = Zip.build(zipEntries)
      Util.downloadBlob(blob, `${base}_全话MP3.zip`)
      batchStatus.value = `完成！${zipEntries.length}/${entries.value.length} 话，ZIP 已下载`
      Message.success('批量生成完成')
    } else {
      batchStatus.value = '没有生成任何音频'
    }
  } finally {
    busy.value = false
    batchRunning.value = false
  }
}

// ── settings ───────────────────────────────────────────────────────────
function openSettings() {
  proxyCustom.value = ProxyUtil.getCustom()
  proxyIdx.value = proxyCustom.value ? 'custom' : String(ProxyUtil.getIndex())
  relayBase.value = getRelayBase()
  proxyTestResult.value = ''
  settingsOpen.value = true
}
function saveSettings() {
  if (proxyIdx.value === 'custom') {
    ProxyUtil.setCustom(proxyCustom.value.trim())
  } else {
    ProxyUtil.setIndex(parseInt(proxyIdx.value, 10))
    ProxyUtil.setCustom('')
  }
  setRelayBase(relayBase.value)
  settingsOpen.value = false
  Message.success('设置已保存')
  detectRelay().then(() => { relayMode.value = isRelay() })
}
async function testProxy() {
  const sel = proxyIdx.value === 'custom'
    ? null
    : CONFIG.PROXY_SERVERS[parseInt(proxyIdx.value, 10)]
  const tpl = sel ? sel.template : proxyCustom.value.trim()
  if (!tpl) { Message.error('请先填写自定义代理'); return }
  const headers = (sel && sel.headers) || {}
  const r = await ProxyUtil.testProxy(tpl, headers)
  proxyTestResult.value = r.ok
    ? `✔ 可用 (HTTP ${r.status}, ${r.len} 字节)`
    : `✘ 不可用: ${r.error || 'HTTP ' + r.status}`
}
async function clearCache() {
  await Cache.clear()
  Message.info('缓存已清除')
}

// ── audio events + keyboard ────────────────────────────────────────────
let onKey = null
onMounted(() => {
  detectRelay().then(() => { relayMode.value = isRelay() })
  const audio = Player.audio
  audio.addEventListener('timeupdate', () => { curTime.value = audio.currentTime })
  audio.addEventListener('loadedmetadata', () => { duration.value = audio.duration })
  audio.addEventListener('play', () => { isPlaying.value = true })
  audio.addEventListener('pause', () => { isPlaying.value = false })
  audio.addEventListener('ended', () => { if (autoNext.value) stepEpisode(1) })
  audio.addEventListener('error', () => {
    if (!busy.value && !/语音服务失败|浏览器语音/.test(status.value)) status.value = '播放错误 — 语音合成失败'
  })
  loadAudioSettings()

  const lastWorkInput = localStorage.getItem(LAST_WORK_INPUT_KEY)
  if (lastWorkInput) {
    workIdInput.value = lastWorkInput
    loadWork()
  }

  onKey = (e) => {
    const tag = document.activeElement.tagName
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
    if (e.code === 'Space') { e.preventDefault(); togglePlay() }
    else if (e.key === 'ArrowLeft' && audio.duration) audio.currentTime = Math.max(0, audio.currentTime - 10)
    else if (e.key === 'ArrowRight' && audio.duration) audio.currentTime = Math.min(audio.duration, audio.currentTime + 10)
    else if (e.key === 'ArrowDown') { e.preventDefault(); stepEpisode(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); stepEpisode(-1) }
  }
  document.addEventListener('keydown', onKey)
})
watch([voice, rate, pitch, pbRate, volume, autoNext, saveToLocal], saveAudioSettings)
onBeforeUnmount(() => {
  if (onKey) document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="app">
    <!-- page 1: parse a work -->
    <main v-if="page === 'parse'" class="parse-page">
      <section class="parse-card">
        <div class="app-title">阅读机</div>
        <p class="parse-intro gray-text">输入 Kakuyomu 作品 ID 或完整链接，解析完成后进入阅读页。</p>
        <input v-model="workIdInput" class="text-input parse-input" placeholder="作品 ID 或完整 URL" @keydown.enter="loadWork" />
        <div class="parse-actions">
          <GButton type="shrink" @click="loadWork" :disable="busy">解析作品</GButton>
          <GButton type="shrink" class="gear-btn" @click="openSettings" title="设置">⚙</GButton>
        </div>
        <div class="mode-badge" :class="isEdge ? 'ok' : 'warn'">
          <span class="mode-logo" aria-hidden="true">
            <svg viewBox="0 0 24 24" role="img">
              <path d="M4 4h8.7L21 12.3 12.3 21 4 12.7V4Zm3 2v5.9l5.3 5.3 5.9-5.9-5.3-5.3H7Z" />
              <circle cx="8.4" cy="8.4" r="1.2" />
            </svg>
          </span>
          <span>{{ modeLabel }}</span>
        </div>
      </section>
    </main>

    <!-- page 2: browse and read -->
    <main v-else class="reader-page">
      <header class="reader-header">
        <button class="back-button" type="button" @click="openParsePage">← 重新解析</button>
        <div class="reader-work-info">
          <div class="reader-work-title">{{ work.meta.title }}</div>
          <div class="gray-text">{{ work.meta.author }} · {{ entries.length }} 话</div>
        </div>
      </header>

      <section class="reader-content">
        <template v-if="current">
          <article class="reader-panel">
            <div class="ep-title">{{ current.episode.title }}</div>
            <div class="ep-sub gray-text">
              {{ work.meta.title }} · <span class="gold-text">{{ current.index }}/{{ entries.length }}</span>
            </div>
            <div class="status-line">{{ status }}</div>
            <article v-if="currentText" class="episode-text">{{ currentText }}</article>
            <div v-else class="reader-wait gray-text">正在准备正文…</div>
          </article>
        </template>
        <div v-else class="empty-reader">
          <div class="empty-reader-title">开始阅读</div>
          <div class="gray-text">点击底部的「目录」选择章节。</div>
        </div>

        <div v-if="batchRunning || batchProgress > 0" class="batch-progress reader-batch-progress">
          <div class="progress-track"><div class="progress-fill" :style="{ width: batchProgress + '%' }"></div></div>
          <div class="gray-text batch-status">{{ batchStatus }}</div>
        </div>
      </section>

      <aside v-if="chaptersOpen" class="chapter-drawer">
        <div class="drawer-header">
          <div class="gold-text">章节目录</div>
          <button class="drawer-close" type="button" @click="chaptersOpen = false" title="关闭目录">×</button>
        </div>
        <div class="tree">
          <ChapterNode :node="work.root" :depth="0" :index-map="indexMap" :active-id="activeId" @select="selectEpisode" />
        </div>
      </aside>
      <button v-if="chaptersOpen" class="drawer-mask" type="button" aria-label="关闭目录" @click="chaptersOpen = false"></button>

      <section v-if="audioControlsOpen" class="audio-sheet">
        <div class="settings-grid">
          <label class="setting">发音人
            <GSelect v-model="voice" :options="voiceOptions" />
          </label>
          <label class="setting">语速
            <GSelect v-model="rate" :options="rateOptions" />
          </label>
          <label class="setting">音调
            <GSelect v-model="pitch" :options="pitchOptions" />
          </label>
          <label class="setting">播放倍速
            <GSelect v-model="pbRate" :options="pbRateOptions" />
          </label>
          <label class="setting">
            <span>音量</span>
            <input type="range" min="0" max="1" step="0.05" :value="volume" @input="onVolume" />
          </label>
          <div class="setting switch-row">
            <span>自动下一话</span>
            <GSwitch v-model="autoNext" />
          </div>
          <div class="setting switch-row">
            <span>保存 MP3</span>
            <GSwitch v-model="saveToLocal" onText="开" offText="关" />
          </div>
        </div>
      </section>

      <section v-if="moreOpen" class="toolbar-more-menu">
        <GButton type="shrink" @click="downloadEpub" :disable="busy || !work">下载 EPUB</GButton>
        <GButton type="shrink" @click="generateAll" :disable="busy || !work">生成全话 MP3</GButton>
        <GButton type="shrink" @click="moreOpen = false; openSettings()">连接设置</GButton>
        <GButton type="shrink" @click="openParsePage">重新解析</GButton>
      </section>

      <footer class="bottom-toolbar">
        <div v-if="current" class="progress-row toolbar-progress">
          <span class="time gray-text">{{ fmtTime(curTime) }}</span>
          <input type="range" class="progress-bar" min="0" :max="duration || 1" step="0.1" :value="curTime" @input="onSeek" />
          <span class="time gray-text">{{ fmtTime(duration) }}</span>
        </div>
        <div class="toolbar-actions">
          <GButton type="shrink" class="toolbar-action" @click="stepEpisode(-1)" :disable="!current" title="上一话">
            <span class="toolbar-icon">‹</span><span>上一话</span>
          </GButton>
          <GButton type="shrink" class="toolbar-action" @click="chaptersOpen = !chaptersOpen; audioControlsOpen = false; moreOpen = false">
            <span class="toolbar-icon">☰</span><span>目录</span>
          </GButton>
          <GButton type="shrink" class="toolbar-action toolbar-play" @click="togglePlay" :disable="!current" title="播放/暂停">
            <span class="toolbar-icon">{{ isPlaying ? 'Ⅱ' : '▶' }}</span><span>{{ isPlaying ? '暂停' : '播放' }}</span>
          </GButton>
          <GButton type="shrink" class="toolbar-action" @click="toggleAudioControls">
            <span class="toolbar-icon">♫</span><span>调音</span>
          </GButton>
          <GButton type="shrink" class="toolbar-action" @click="toggleMoreMenu">
            <span class="toolbar-icon">•••</span><span>更多</span>
          </GButton>
          <GButton type="shrink" class="toolbar-action" @click="stepEpisode(1)" :disable="!current" title="下一话">
            <span class="toolbar-icon">›</span><span>下一话</span>
          </GButton>
        </div>
      </footer>
    </main>

    <!-- settings modal -->
    <GModal :visible="settingsOpen" title="设置" theme="dark" @close="settingsOpen = false"
            :ok="{ text: '保存' }" @ok="saveSettings" :cancel="{ text: '取消' }" @cancel="settingsOpen = false">
      <div class="modal-body">
        <div class="setting">
          <span>中转后端地址（可留空）</span>
          <input v-model="relayBase" class="text-input"
                 placeholder="如 https://xxx.onrender.com —— 静态前端指向单独的 Node 后端，任意浏览器可放 MP3" />
          <span class="gray-text modal-hint">留空 = 与本站同源（server.js 直接托管本站）时自动生效</span>
        </div>
        <div class="setting">
          <span>CORS 代理（无中转时才用）</span>
          <GSelect v-model="proxyIdx" :options="proxyOptions" />
        </div>
        <div class="setting">
          <span>自定义代理模板</span>
          <input v-model="proxyCustom" class="text-input" placeholder="https://your-proxy.com/?url={url}" />
        </div>
        <div class="setting-row">
          <GButton type="shrink" @click="testProxy">测试代理</GButton>
          <span class="gray-text modal-hint">{{ proxyTestResult }}</span>
        </div>
        <div class="setting-row">
          <GButton type="shrink" @click="clearCache">清除本地缓存</GButton>
          <span class="gray-text modal-hint">缓存加速重复下载</span>
        </div>
      </div>
    </GModal>

    <!-- loading overlay -->
    <div v-if="loading" class="loading-overlay">
      <div class="loading-box">
        <div class="loading-spinner"></div>
        <div class="loading-text">{{ loadingText }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100vh; }

/* left function area */
.app-title { font-size: 22px; font-weight: 600; }
.side-brand {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 8px 8px 18px;
  border-bottom: 1px solid rgba(180, 148, 96, 0.25);
}
.brand-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.sidebar-toggle {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border: 1px solid rgba(180, 148, 96, 0.45);
  border-radius: 6px;
  background: rgba(180, 148, 96, 0.08);
  color: var(--font-gold, #fed57f);
  font-size: 24px;
  line-height: 24px;
  cursor: pointer;
}
.sidebar-toggle:hover {
  background: rgba(254, 213, 127, 0.18);
}
.side-brand .mode-badge { align-self: flex-start; margin-left: 0; }
.wid-input { width: 100%; }
.gear-btn { width: 50px; min-width: 50px; flex: 0 0 50px; padding: 0; }
.function-panel {
  padding: 16px 8px;
  border-bottom: 1px solid rgba(180, 148, 96, 0.25);
}
.side-section-title { font-size: 14px; font-weight: 600; margin-bottom: 10px; }
.function-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.function-actions :deep(.button-wrap-button) { flex: 1 1 auto; min-width: 0; }
.work-info { margin-top: 16px; min-width: 0; }
.work-title {
  font-size: 14px;
  color: var(--blank-white, #ede5d8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.work-meta { font-size: 12px; margin-top: 2px; }
.work-tags { display: flex; gap: 4px; margin-top: 4px; flex-wrap: wrap; }
.tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 3px;
  border: 1px solid rgba(180, 148, 96, 0.4);
  color: var(--font-gold, #fed57f);
  background: rgba(180, 148, 96, 0.08);
}
.mode-badge {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid;
  white-space: nowrap;
}
.mode-logo {
  display: inline-flex;
  width: 15px;
  height: 15px;
  flex: 0 0 15px;
}
.mode-logo svg {
  width: 100%;
  height: 100%;
  fill: currentColor;
}
.mode-badge.ok { color: var(--font-green, #6bb463); border-color: rgba(107, 180, 99, 0.5); background: rgba(107, 180, 99, 0.1); }
.mode-badge.warn { color: var(--font-gold, #fed57f); border-color: rgba(254, 213, 127, 0.5); background: rgba(254, 213, 127, 0.1); }

/* main */
.app-main { flex: 1; display: flex; min-height: 0; }
.app-side {
  width: 320px;
  min-width: 280px;
  overflow-y: auto;
  padding: 14px 12px;
  border-right: 1px solid rgba(180, 148, 96, 0.25);
  background: rgba(10, 18, 30, 0.55);
  transition: width 0.22s ease, min-width 0.22s ease, padding 0.22s ease;
}
.app-side.collapsed {
  width: 68px;
  min-width: 68px;
  padding-left: 8px;
  padding-right: 8px;
}
.app-side.collapsed .side-brand {
  align-items: center;
  padding-left: 0;
  padding-right: 0;
}
.app-side.collapsed .brand-row { width: 100%; flex-direction: column; }
.app-side.collapsed .app-title { font-size: 16px; }
.app-side.collapsed .mode-badge { display: none; }
.chapter-panel { padding-top: 14px; }
.side-title { font-size: 14px; font-weight: 600; padding: 4px 8px 10px; }
.side-empty { padding: 24px; text-align: center; font-size: 13px; }

.app-content { flex: 1; min-width: 0; overflow-y: auto; padding: 24px 32px; display: flex; flex-direction: column; gap: 16px; }
.browse-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 4px 4px;
}
.browse-title { font-size: 20px; font-weight: 600; color: #f6e3b4; }
.browse-subtitle { font-size: 12px; margin-top: 4px; }
.browse-work-title { max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c8d0db; font-size: 13px; }

/* panels */
.panel {
  background: linear-gradient(160deg, rgba(18, 30, 46, 0.92), rgba(12, 21, 34, 0.9));
  border: 1px solid rgba(180, 148, 96, 0.35);
  border-radius: 10px;
  padding: 24px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
}
.player-panel { width: 100%; margin: 0; }
.empty-panel { text-align: center; padding: 40px 0; font-size: 14px; }
.ep-title { font-size: 17px; font-weight: 600; text-align: center; margin-bottom: 4px; }
.ep-sub { font-size: 12px; text-align: center; margin-bottom: 18px; }

.progress-row { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
.progress-row .time { font-size: 12px; min-width: 44px; font-variant-numeric: tabular-nums; }
.progress-row .time:last-child { text-align: right; }
.progress-bar { flex: 1; width: 100%; cursor: pointer; }

.controls { display: flex; align-items: center; justify-content: center; gap: 16px; margin-bottom: 20px; }
.ctl { width: 58px; min-height: 50px; flex: 0 0 58px; }
.ctl.play { width: 68px; flex-basis: 68px; }

.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px 20px;
  align-items: center;
  margin-bottom: 14px;
}
.setting {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--font-light-gray, #747780);
}
.switch-row { flex-direction: row; align-items: center; justify-content: space-between; }

.status-line {
  text-align: center;
  font-size: 12px;
  color: var(--font-gold, #fed57f);
  min-height: 18px;
}

.text-panel {
  margin-top: 14px;
  border-top: 1px solid rgba(180, 148, 96, 0.22);
  padding-top: 10px;
}
.text-panel summary {
  cursor: pointer;
  color: var(--font-light-gray, #a6a9b2);
  font-size: 12px;
  user-select: none;
}
.episode-text {
  margin-top: 10px;
  max-height: 360px;
  overflow-y: auto;
  white-space: pre-wrap;
  line-height: 1.85;
  color: var(--blank-white, #ede5d8);
  font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif;
  font-size: 14px;
}

/* batch */
.batch-panel { width: 100%; margin: 0; }
.batch-title { font-size: 15px; font-weight: 600; margin-bottom: 8px; }
.batch-hint { font-size: 12px; margin-bottom: 12px; }
.batch-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.batch-progress { margin-top: 6px; }
.progress-track { height: 8px; border-radius: 4px; background: rgba(72, 85, 103, 0.5); overflow: hidden; }
.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--selected-border, #82b245), #a8d24f);
  border-radius: 4px;
  transition: width 0.3s;
}
.batch-status { font-size: 12px; margin-top: 6px; }

/* modal */
.modal-body { display: flex; flex-direction: column; gap: 14px; color: var(--blank-white, #ede5d8); }
.modal-body .setting { flex-direction: column; gap: 6px; }
.setting-row { display: flex; align-items: center; gap: 12px; }
.modal-hint { font-size: 12px; }

/* loading overlay */
.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(4, 8, 14, 0.72);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 999;
  backdrop-filter: blur(2px);
}
.loading-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 28px 40px;
  border: 1px solid rgba(180, 148, 96, 0.4);
  border-radius: 12px;
  background: rgba(16, 26, 40, 0.95);
}
.loading-spinner {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 3px solid rgba(72, 85, 103, 0.6);
  border-top-color: var(--font-gold, #fed57f);
  animation: spin 0.8s linear infinite;
}
.loading-text { font-size: 14px; color: var(--font-gold, #fed57f); }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 700px) {
  .app-title { font-size: 19px; }
  .wid-input { width: 100%; min-width: 0; flex: 1 1 100%; }
  .side-brand { flex-direction: row; align-items: center; justify-content: space-between; }
  .function-panel { padding: 14px 4px; }
  .function-actions :deep(.button-wrap-button) { width: auto; flex: 1 1 auto; }
  .work-info { width: 100%; max-height: 70px; overflow: hidden; }
  .work-tags { max-height: 22px; overflow: hidden; }

  .app-main { flex-direction: column; }
  .app-side {
    width: 100%;
    min-width: 0;
    max-height: 46vh;
    border-right: 0;
    border-bottom: 1px solid rgba(180, 148, 96, 0.25);
  }
  .app-side.collapsed {
    width: 100%;
    min-width: 0;
    max-height: 64px;
  }
  .app-side.collapsed .brand-row { flex-direction: row; }
  .app-content { padding: 16px 12px; gap: 12px; }
  .browse-header { align-items: flex-start; flex-direction: column; gap: 6px; }
  .browse-work-title { max-width: 100%; }
  .panel { padding: 16px; }
  .settings-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .setting { min-width: 0; }
  .controls { gap: 8px; }
  .ctl { width: 52px; min-width: 52px; flex-basis: 52px; }
  .ctl.play { width: 60px; flex-basis: 60px; }
  .batch-actions { flex-wrap: wrap; }
  .batch-status { overflow-wrap: anywhere; }
}
</style>

<style scoped>
/* Two-page flow: parse page first, then a focused reader page. */
.parse-page {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  padding: clamp(28px, 10vw, 150px);
}
.parse-card {
  width: min(100%, 520px);
  padding: clamp(28px, 5vw, 52px);
  border: 1px solid rgba(180, 148, 96, 0.38);
  border-radius: 18px;
  background: linear-gradient(145deg, rgba(17, 30, 47, 0.96), rgba(10, 18, 30, 0.92));
  box-shadow: 0 18px 52px rgba(0, 0, 0, 0.32);
}
.parse-card .app-title { font-size: clamp(28px, 4vw, 40px); }
.parse-intro { margin: 14px 0 24px; line-height: 1.7; }
.parse-input { width: 100%; }
.parse-actions { display: flex; gap: 10px; margin-top: 12px; }
.parse-actions :deep(.button-wrap-button):first-child { flex: 1; }
.parse-card .mode-badge { margin: 22px 0 0; }

.reader-page {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.reader-header {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 64px;
  padding: 10px clamp(16px, 4vw, 56px);
  border-bottom: 1px solid rgba(180, 148, 96, 0.28);
  background: rgba(10, 18, 30, 0.72);
}
.back-button, .drawer-close {
  border: 0;
  background: transparent;
  color: var(--font-gold, #fed57f);
  cursor: pointer;
  font-size: 14px;
}
.back-button:hover, .drawer-close:hover { color: #fff0be; }
.reader-work-info { min-width: 0; }
.reader-work-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 16px; color: #f6e3b4; }
.reader-work-info .gray-text { margin-top: 3px; font-size: 12px; }
.reader-content {
  flex: 1;
  overflow-y: auto;
  padding: 30px clamp(18px, 9vw, 160px) 180px;
}
.reader-panel, .empty-reader {
  width: min(100%, 900px);
  margin: 0 auto;
}
.reader-panel {
  padding: clamp(22px, 4vw, 46px);
  border: 1px solid rgba(180, 148, 96, 0.32);
  border-radius: 14px;
  background: rgba(15, 26, 42, 0.78);
}
.reader-panel .ep-title { font-size: clamp(19px, 2.5vw, 26px); }
.reader-panel .ep-sub { margin-bottom: 14px; }
.reader-panel .status-line { margin-bottom: 16px; }
.reader-panel .episode-text {
  max-height: none;
  overflow: visible;
  padding-top: 18px;
  border-top: 1px solid rgba(180, 148, 96, 0.2);
  font-size: 16px;
  line-height: 2;
}
.reader-wait, .empty-reader { text-align: center; padding: 72px 20px; }
.empty-reader-title { margin-bottom: 10px; color: #f6e3b4; font-size: 22px; }
.reader-batch-progress { width: min(100%, 900px); margin: 18px auto 0; }

.chapter-drawer {
  position: absolute;
  z-index: 30;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(360px, 88vw);
  overflow-y: auto;
  padding: 18px 12px 112px;
  border-left: 1px solid rgba(180, 148, 96, 0.42);
  background: #101c2d;
  box-shadow: -16px 0 42px rgba(0, 0, 0, 0.35);
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 14px;
  font-size: 16px;
}
.drawer-close { font-size: 26px; line-height: 1; }
.drawer-mask {
  position: absolute;
  z-index: 20;
  inset: 0;
  border: 0;
  background: rgba(0, 0, 0, 0.34);
}

.audio-sheet {
  position: absolute;
  z-index: 24;
  right: clamp(12px, 4vw, 56px);
  bottom: 100px;
  width: min(680px, calc(100% - 24px));
  padding: 18px;
  border: 1px solid rgba(180, 148, 96, 0.42);
  border-radius: 12px;
  background: rgba(13, 24, 39, 0.98);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.audio-sheet .settings-grid { margin-bottom: 0; }
.toolbar-more-menu {
  position: absolute;
  z-index: 24;
  bottom: 108px;
  left: 50%;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  width: min(620px, calc(100% - 32px));
  padding: 12px;
  transform: translateX(-50%);
  border: 1px solid rgba(180, 148, 96, 0.42);
  border-radius: 14px;
  background: rgba(13, 24, 39, 0.98);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
}
.bottom-toolbar {
  position: absolute;
  z-index: 25;
  left: 50%;
  right: auto;
  bottom: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 7px;
  width: min(620px, calc(100% - 32px));
  transform: translateX(-50%);
  padding: 8px;
  border: 1px solid rgba(180, 148, 96, 0.42);
  border-bottom: 0;
  border-radius: 16px 16px 0 0;
  background: rgba(10, 18, 30, 0.96);
  box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.3);
}
.toolbar-progress { width: 100%; min-width: 0; margin: 0; }
.toolbar-actions {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 4px;
  width: 100%;
}
.toolbar-actions :deep(.button-wrap-button) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-width: 0;
  min-height: 58px;
  padding: 5px 2px;
  border-radius: 9px;
  line-height: 1.15;
}
.toolbar-icon {
  display: block;
  min-height: 25px;
  font-size: 22px;
  line-height: 22px;
}
.toolbar-play :deep(.button-wrap-button) {
  color: var(--font-gold, #fed57f);
  border-color: rgba(254, 213, 127, 0.65);
  background: rgba(254, 213, 127, 0.12);
}

@media (max-width: 700px) {
  .parse-page { align-items: flex-start; padding: 56px 16px; }
  .parse-card { width: 100%; }
  .reader-header { padding: 9px 14px; }
  .reader-content { padding: 22px 12px 204px; }
  .reader-panel { padding: 22px 18px; }
  .reader-panel .episode-text { font-size: 15px; line-height: 1.9; }
  .audio-sheet { right: 12px; bottom: 138px; }
  .toolbar-more-menu {
    right: 12px;
    bottom: 132px;
    left: 12px;
    width: auto;
    transform: none;
  }
  .bottom-toolbar {
    right: 12px;
    bottom: 10px;
    left: 12px;
    width: auto;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    transform: none;
    padding: 8px 10px;
    border-bottom: 1px solid rgba(180, 148, 96, 0.42);
    border-radius: 14px;
  }
  .toolbar-progress { width: 100%; min-width: 0; }
  .toolbar-actions { width: 100%; gap: 3px; }
  .toolbar-actions :deep(.button-wrap-button) { min-width: 0; }
}
</style>
