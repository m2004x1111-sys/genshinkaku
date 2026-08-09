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

// ── state ──────────────────────────────────────────────────────────────
const workIdInput = ref('')
const work = ref(null)
const entries = ref([])
const episodeParas = ref(new Map())
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

const isEdge = computed(() => Util.isEdgeTTSBrowser())

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
  { text: 'allorigins.win', value: '0' },
  { text: 'corsproxy.io', value: '1' },
  { text: '自定义代理', value: 'custom' },
]

function fmtTime(t) {
  if (!isFinite(t) || t < 0) return '…'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
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
  episodeParas.value = new Map()
  status.value = ''
}

async function loadWork() {
  const input = workIdInput.value.trim()
  if (!input) { Message.error('请输入作品 ID 或 URL'); return }
  const wid = Kakuyomu.parseWorkId(input)

  // cache-first: show cached work immediately, refresh in background
  const cached = await Cache.get(wid, 'works')
  if (cached && cached.work) {
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
  playEpisode()
}
function stepEpisode(delta) {
  if (!current.value || !entries.value.length) return
  const idx = current.value.index - 1 + delta
  if (idx < 0 || idx >= entries.value.length) return
  const entry = entries.value[idx]
  current.value = { episode: entry, index: idx + 1 }
  playEpisode()
}

async function playEpisode() {
  if (!current.value || !work.value) return
  const ep = current.value.episode
  Player.stop()
  status.value = '正在获取正文...'
  try {
    const text = await episodeText(ep)
    if (!text) { status.value = '正文为空 — 可能抓取失败'; return }

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
        status.value = 'edge-tts 失败，切换到浏览器语音'
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
  settingsOpen.value = false
  Message.success('代理设置已保存')
}
async function testProxy() {
  const tpl = proxyIdx.value === 'custom'
    ? proxyCustom.value.trim()
    : CONFIG.PROXY_SERVERS[parseInt(proxyIdx.value, 10)].template
  if (!tpl) { Message.error('请先填写自定义代理'); return }
  const r = await ProxyUtil.testProxy(tpl)
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
  const audio = Player.audio
  audio.addEventListener('timeupdate', () => { curTime.value = audio.currentTime })
  audio.addEventListener('loadedmetadata', () => { duration.value = audio.duration })
  audio.addEventListener('play', () => { isPlaying.value = true })
  audio.addEventListener('pause', () => { isPlaying.value = false })
  audio.addEventListener('ended', () => { if (autoNext.value) stepEpisode(1) })
  audio.addEventListener('error', () => { if (!busy.value) status.value = '播放错误 — 语音合成失败' })

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
onBeforeUnmount(() => {
  if (onKey) document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div class="app">
    <!-- header -->
    <header class="app-header">
      <div class="app-title">カクヨム TTS</div>
      <input v-model="workIdInput" class="text-input wid-input" placeholder="作品 ID 或完整 URL" @keydown.enter="loadWork" />
      <GButton type="shrink" @click="loadWork" :disable="busy">读取</GButton>
      <GButton type="shrink" @click="downloadEpub" :disable="busy || !work">EPUB</GButton>
      <GButton type="shrink" @click="generateAll" :disable="busy || !work">全话 MP3</GButton>
      <GButton type="shrink" shape="round" @click="openSettings" title="设置">⚙</GButton>

      <div v-if="work" class="work-info">
        <div class="work-title">{{ work.meta.title }}</div>
        <div class="work-meta gray-text">
          {{ work.meta.author }} · <span class="gold-text">{{ entries.length }}</span> 话
        </div>
        <div v-if="work.meta.tags && work.meta.tags.length" class="work-tags">
          <span v-for="t in work.meta.tags" :key="t" class="tag">{{ t }}</span>
        </div>
      </div>

      <div class="mode-badge" :class="isEdge ? 'ok' : 'warn'">
        {{ isEdge ? 'Edge TTS · 可导出 MP3' : '浏览器语音 · 无 MP3' }}
      </div>
    </header>

    <!-- main -->
    <main class="app-main">
      <aside class="app-side">
        <div class="side-title gold-text">章節目次</div>
        <div v-if="work" class="tree">
          <ChapterNode :node="work.root" :depth="0" :index-map="indexMap" :active-id="activeId" @select="selectEpisode" />
        </div>
        <div v-else class="side-empty gray-text">输入作品 ID 后点击「读取」</div>
      </aside>

      <section class="app-content">
        <!-- player -->
        <div class="panel player-panel">
          <template v-if="current">
            <div class="ep-title">{{ current.episode.title }}</div>
            <div class="ep-sub gray-text">
              {{ work.meta.title }} · <span class="gold-text">{{ current.index }}/{{ entries.length }}</span>
            </div>

            <div class="progress-row">
              <span class="time gray-text">{{ fmtTime(curTime) }}</span>
              <input type="range" class="progress-bar" min="0" :max="duration || 1" step="0.1"
                     :value="curTime" @input="onSeek" />
              <span class="time gray-text">{{ fmtTime(duration) }}</span>
            </div>

            <div class="controls">
              <GButton type="shrink" class="ctl" @click="stepEpisode(-1)" title="上一话">⏮</GButton>
              <GButton type="shrink" class="ctl play" @click="togglePlay" title="播放/暂停">{{ isPlaying ? '⏸' : '▶' }}</GButton>
              <GButton type="shrink" class="ctl" @click="stepEpisode(1)" title="下一话">⏭</GButton>
            </div>

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

            <div class="status-line">{{ status }}</div>
          </template>
          <div v-else class="empty-panel gray-text">← 点击左侧章节开始朗读</div>
        </div>

        <!-- batch -->
        <div class="panel batch-panel">
          <div class="batch-title gold-text">批量生成 MP3（ZIP）</div>
          <div class="gray-text batch-hint">逐话合成全部音频，完成后自动下载一个 ZIP 压缩包。</div>
          <div class="batch-actions">
            <GButton type="shrink" @click="generateAll" :disable="busy || !work">开始生成</GButton>
            <span v-if="batchRunning" class="gray-text">{{ batchStatus }}</span>
          </div>
          <div v-if="batchRunning || batchProgress > 0" class="batch-progress">
            <div class="progress-track"><div class="progress-fill" :style="{ width: batchProgress + '%' }"></div></div>
            <div class="gray-text batch-status">{{ batchStatus }}</div>
          </div>
        </div>
      </section>
    </main>

    <!-- settings modal -->
    <GModal :visible="settingsOpen" title="设置" theme="dark" @close="settingsOpen = false"
            :ok="{ text: '保存' }" @ok="saveSettings" :cancel="{ text: '取消' }" @cancel="settingsOpen = false">
      <div class="modal-body">
        <div class="setting">
          <span>CORS 代理</span>
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

/* header */
.app-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 14px 20px;
  background: linear-gradient(180deg, rgba(15, 24, 38, 0.95), rgba(10, 17, 28, 0.9));
  border-bottom: 1px solid rgba(180, 148, 96, 0.35);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
}
.app-title { font-size: 22px; font-weight: 600; }
.wid-input { width: 240px; }
.work-info { margin-left: 8px; max-width: 420px; min-width: 0; }
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
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid;
  white-space: nowrap;
}
.mode-badge.ok { color: var(--font-green, #6bb463); border-color: rgba(107, 180, 99, 0.5); background: rgba(107, 180, 99, 0.1); }
.mode-badge.warn { color: var(--font-gold, #fed57f); border-color: rgba(254, 213, 127, 0.5); background: rgba(254, 213, 127, 0.1); }

/* main */
.app-main { flex: 1; display: flex; min-height: 0; }
.app-side {
  width: 300px;
  min-width: 240px;
  overflow-y: auto;
  padding: 12px 8px;
  border-right: 1px solid rgba(180, 148, 96, 0.25);
  background: rgba(10, 18, 30, 0.55);
}
.side-title { font-size: 14px; font-weight: 600; padding: 4px 8px 10px; }
.side-empty { padding: 24px; text-align: center; font-size: 13px; }

.app-content { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 16px; }

/* panels */
.panel {
  background: linear-gradient(160deg, rgba(18, 30, 46, 0.92), rgba(12, 21, 34, 0.9));
  border: 1px solid rgba(180, 148, 96, 0.35);
  border-radius: 10px;
  padding: 24px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
}
.player-panel { max-width: 680px; width: 100%; margin: 0 auto; }
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

/* batch */
.batch-panel { max-width: 680px; width: 100%; margin: 0 auto; }
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
</style>
