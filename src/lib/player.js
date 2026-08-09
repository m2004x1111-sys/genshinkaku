import { EdgeTTS } from './edge-tts.js'

/* audio controller: streams edge-tts MP3 into MediaSource when supported,
   otherwise accumulate-then-play. Plus a Web Speech API fallback. */
export const Player = (() => {
  const audio = new Audio()
  audio.preload = 'auto'
  audio.volume = 1

  let session = 0
  let ms = null
  let blobUrl = null
  let mode = 'edge' // 'edge' | 'speech'

  function stop() {
    session++
    if (window.speechSynthesis) speechSynthesis.cancel()
    if (ms && ms.readyState !== 'closed') {
      try { ms.endOfStream() } catch (e) { /* ignore */ }
      try { ms = null } catch (e) { /* ignore */ }
    }
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }

  // resolves when synthesis finishes; returns an MP3 Blob when save is on
  async function play({ text, voice, rate, pitch = '+0Hz', save = false, onStatus }) {
    const my = ++session
    mode = 'edge'
    const collected = []
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null }

    const mseOk = !!(window.MediaSource && MediaSource.isTypeSupported('audio/mpeg'))
    const opts = { voice: EdgeTTS.voiceName(voice), rate, pitch }

    const ensurePlaying = () => {
      if (started || audio.readyState < 1) return
      audio.play().then(() => { started = true }).catch(() => {})
    }
    let started = false

    try {
      if (mseOk) {
        ms = new MediaSource()
        blobUrl = URL.createObjectURL(ms)
        audio.src = blobUrl
        await new Promise((res, rej) => {
          ms.addEventListener('sourceopen', res, { once: true })
          ms.addEventListener('error', () => rej(new Error('MediaSource 错误')), { once: true })
        })
        if (my !== session) return null
        const sb = ms.addSourceBuffer('audio/mpeg')
        const append = (buf) => new Promise((res) => {
          const onUpd = () => { sb.removeEventListener('updateend', onUpd); res() }
          sb.addEventListener('updateend', onUpd)
          try { sb.appendBuffer(buf) } catch (e) { res() }
        })

        for await (const chunk of EdgeTTS.stream(text, opts)) {
          if (my !== session) return null
          collected.push(chunk)
          await append(chunk)
          ensurePlaying()
        }
        if (my !== session) return null
        if (ms.readyState === 'open') ms.endOfStream()
        ensurePlaying()
        if (onStatus) onStatus('playing')
      } else {
        const parts = []
        for await (const chunk of EdgeTTS.stream(text, opts)) {
          if (my !== session) return null
          collected.push(chunk)
          parts.push(chunk)
        }
        if (my !== session) return null
        blobUrl = URL.createObjectURL(new Blob(parts, { type: 'audio/mpeg' }))
        audio.src = blobUrl
        if (onStatus) onStatus('playing')
        await audio.play().catch(() => {})
      }

      if (save && collected.length) {
        return new Blob(collected, { type: 'audio/mpeg' })
      }
      return null
    } catch (e) {
      if (onStatus) onStatus('error', e.message)
      throw e
    }
  }

  // ── Web Speech API fallback ──────────────────────────────────────────────
  let _lastUtterance = null
  function getJaVoice() {
    const vs = window.speechSynthesis ? speechSynthesis.getVoices() : []
    return vs.find((v) => /^ja[-_]?JP/i.test(v.lang)) || vs.find((v) => /^ja/i.test(v.lang)) || null
  }
  function playSpeech({ text, rate = '+0%', pitch = '+0Hz', onStatus, onEnd }) {
    return new Promise((resolve) => {
      const my = ++session
      mode = 'speech'
      if (!window.speechSynthesis) { resolve(null); return }
      speechSynthesis.cancel()
      const u = new SpeechSynthesisUtterance(text)
      _lastUtterance = u
      const ja = getJaVoice()
      if (ja) u.voice = ja
      const pct = parseInt(String(rate), 10) || 0
      u.rate = Math.min(2, Math.max(0.5, 1 + pct / 100))
      u.pitch = 1
      u.lang = 'ja-JP'
      if (onStatus) onStatus('speaking')
      u.onend = () => {
        if (my === session) { if (onStatus) onStatus('done'); if (onEnd) onEnd() }
        resolve(null)
      }
      u.onerror = () => {
        if (onStatus) onStatus('error', '浏览器语音播放失败')
        resolve(null)
      }
      speechSynthesis.speak(u)
    })
  }
  function toggleSpeech() {
    if (!window.speechSynthesis) return
    if (speechSynthesis.speaking) {
      if (speechSynthesis.paused) speechSynthesis.resume()
      else speechSynthesis.pause()
    } else if (_lastUtterance) {
      speechSynthesis.resume()
    }
  }

  return { audio, play, playSpeech, toggleSpeech, stop, get mode() { return mode } }
})()
