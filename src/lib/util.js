import { EDGE_TTS_TOKEN, CONFIG } from './config.js'

/* small utilities: pure-JS SHA-256, byte splitting, escaping. */
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function utf8Len(str) {
  return encoder.encode(str).length
}

function hexUUID() {
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('')
}

// ── SHA-256 (hex, uppercase) ─────────────────────────────────────────────
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]
const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]
const rrot = (n, s) => (n >>> s) | (n << (32 - s))

function sha256Hex(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i) & 0xff)
  const bitLenHi = Math.floor((bytes.length * 8) / 0x100000000)
  const bitLenLo = (bytes.length * 8) & 0xffffffff
  bytes.push(0x80)
  while (bytes.length % 64 !== 56) bytes.push(0)
  const push32 = (v) => {
    bytes.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff)
  }
  push32(bitLenHi)
  push32(bitLenLo)

  const H = H0.slice()
  const w = new Array(64)
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      const o = i + t * 4
      w[t] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rrot(w[t - 15], 7) ^ rrot(w[t - 15], 18) ^ (w[t - 15] >>> 3)
      const s1 = rrot(w[t - 2], 17) ^ rrot(w[t - 2], 19) ^ (w[t - 2] >>> 10)
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let t = 0; t < 64; t++) {
      const S1 = rrot(e, 6) ^ rrot(e, 11) ^ rrot(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0
      const S0 = rrot(a, 2) ^ rrot(a, 13) ^ rrot(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0
  }
  let hex = ''
  for (let i = 0; i < 8; i++) hex += (H[i] >>> 0).toString(16).padStart(8, '0')
  return hex.toUpperCase()
}

// ── Sec-MS-GEC token ────────────────────────────────────────────────────
function generateSecMsGec(nowMs = Date.now()) {
  const WIN_EPOCH = 11644473600n
  let ticks = BigInt(Math.floor(nowMs / 1000))
  ticks += WIN_EPOCH
  ticks -= ticks % 300n
  ticks *= 10000000n
  const strToHash = `${ticks}${EDGE_TTS_TOKEN}`
  return sha256Hex(strToHash)
}

// ── escaping / cleaning ─────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function removeIncompatibleChars(s) {
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
}

function cutSafeUtf8(s, maxBytes) {
  let enc = encoder.encode(s)
  if (enc.length <= maxBytes) return s
  enc = enc.slice(0, maxBytes)
  while (enc.length) {
    try {
      decoder.decode(enc)
      break
    } catch (e) {
      enc = enc.slice(0, enc.length - 1)
    }
  }
  return decoder.decode(enc)
}

function splitTextByBytes(text, maxBytes = CONFIG.TTS_CHUNK_BYTES) {
  const chunks = []
  let cur = ''
  const pushIfNeeded = (add) => {
    const joined = cur ? cur + add : add
    if (utf8Len(joined) > maxBytes && cur) {
      chunks.push(cur)
      return add
    }
    return joined
  }
  const lines = text.split('\n')
  for (const line of lines) {
    if (utf8Len(line) <= maxBytes) {
      cur = pushIfNeeded(line.length ? '\n' + line : line)
    } else {
      if (cur) { chunks.push(cur); cur = '' }
      const words = line.split(' ')
      for (const w of words) {
        if (utf8Len(w) > maxBytes) {
          if (cur) { chunks.push(cur); cur = '' }
          let s = w
          while (utf8Len(s) > maxBytes) {
            let cut = cutSafeUtf8(s, maxBytes)
            chunks.push(cut)
            s = s.slice(cut.length)
          }
          cur = s
        } else {
          cur = pushIfNeeded(cur ? ' ' + w : w)
        }
      }
    }
  }
  if (cur) chunks.push(cur)
  return chunks.filter(Boolean)
}

function cleanFilename(name, maxLen = 60) {
  let s = String(name).replace(/:/g, '：').replace(/[\\/?*<>|"]/g, '_')
  if (s.length > maxLen) s = s.slice(0, maxLen - 3).replace(/\s+$/, '') + '...'
  return s.trim()
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30000)
}

// edge-tts websocket requires a User-Agent containing recent Chrome + Edg
function isEdgeTTSBrowser() {
  const ua = navigator.userAgent
  const edg = (ua.match(/Edg\/(\d+)/) || [])[1]
  const chrome = (ua.match(/Chrome\/(\d+)/) || [])[1]
  const required = 143
  return !!edg && parseInt(edg, 10) >= required && (!chrome || parseInt(chrome, 10) >= required)
}

export const Util = {
  encoder,
  decoder,
  utf8Len,
  hexUUID,
  sha256Hex,
  generateSecMsGec,
  escapeHtml,
  xmlEscape,
  removeIncompatibleChars,
  splitTextByBytes,
  cleanFilename,
  downloadBlob,
  isEdgeTTSBrowser,
}
