import { Util } from './util.js'

/* minimal ZIP writer (STORE method, no external deps) */
export const Zip = (() => {
  function crc32(bytes) {
    let crc = 0 ^ -1
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i]
      for (let k = 0; k < 8; k++) {
        crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
      }
    }
    return (crc ^ -1) >>> 0
  }

  function build(entries) {
    const enc = Util.encoder
    const parts = []
    const central = []
    let offset = 0

    for (const e of entries) {
      const nameBytes = enc.encode(e.name)
      const data = typeof e.content === 'string' ? enc.encode(e.content) : e.content
      const crc = crc32(data)

      const lh = new DataView(new ArrayBuffer(30))
      lh.setUint32(0, 0x04034b50, true)
      lh.setUint16(4, 20, true)
      lh.setUint16(6, 0x0800, true)
      lh.setUint16(8, 0, true)
      lh.setUint16(10, 0, true)
      lh.setUint16(12, 0x21, true)
      lh.setUint32(14, crc, true)
      lh.setUint32(18, data.length, true)
      lh.setUint32(22, data.length, true)
      lh.setUint16(26, nameBytes.length, true)
      lh.setUint16(28, 0, true)
      parts.push(new Uint8Array(lh.buffer), nameBytes, data)
      central.push({ crc, size: data.length, nameBytes, offset })
      offset += 30 + nameBytes.length + data.length
    }

    const cdStart = offset
    let cdSize = 0
    for (const c of central) {
      const cd = new DataView(new ArrayBuffer(46))
      cd.setUint32(0, 0x02014b50, true)
      cd.setUint16(4, 20, true)
      cd.setUint16(6, 20, true)
      cd.setUint16(8, 0x0800, true)
      cd.setUint16(10, 0, true)
      cd.setUint16(12, 0, true)
      cd.setUint16(14, 0x21, true)
      cd.setUint32(16, c.crc, true)
      cd.setUint32(20, c.size, true)
      cd.setUint32(24, c.size, true)
      cd.setUint16(28, c.nameBytes.length, true)
      cd.setUint16(30, 0, true)
      cd.setUint16(32, 0, true)
      cd.setUint16(34, 0, true)
      cd.setUint16(36, 0, true)
      cd.setUint32(38, 0, true)
      cd.setUint32(42, c.offset, true)
      parts.push(new Uint8Array(cd.buffer), c.nameBytes)
      cdSize += 46 + c.nameBytes.length
    }

    const eocd = new DataView(new ArrayBuffer(22))
    eocd.setUint32(0, 0x06054b50, true)
    eocd.setUint16(4, 0, true)
    eocd.setUint16(6, 0, true)
    eocd.setUint16(8, entries.length, true)
    eocd.setUint16(10, entries.length, true)
    eocd.setUint32(12, cdSize, true)
    eocd.setUint32(16, cdStart, true)
    eocd.setUint16(20, 0, true)
    parts.push(new Uint8Array(eocd.buffer))

    return new Blob(parts, { type: 'application/zip' })
  }

  return { build, crc32 }
})()
