/* IndexedDB cache (episode HTML / work JSON). Degrades gracefully. */
export const Cache = (() => {
  let _db = null
  let _disabled = false

  function open() {
    return new Promise((resolve, reject) => {
      if (_db) return resolve(_db)
      if (_disabled) return reject(new Error('indexedDB disabled'))
      if (!window.indexedDB) { _disabled = true; return reject(new Error('no indexedDB')) }
      const req = indexedDB.open('kakuyomub2-web', 1)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('episodes')) db.createObjectStore('episodes')
        if (!db.objectStoreNames.contains('works')) db.createObjectStore('works')
      }
      req.onsuccess = () => { _db = req.result; resolve(_db) }
      req.onerror = () => { _disabled = true; reject(req.error) }
      req.onblocked = () => reject(new Error('indexedDB blocked'))
    })
  }

  function tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      open().then((db) => {
        const t = db.transaction(store, mode)
        const os = t.objectStore(store)
        let result
        try { result = fn(os) } catch (e) { reject(e); return }
        t.oncomplete = () => resolve(result && result.result)
        t.onerror = () => reject(t.error)
      }).catch(reject)
    })
  }

  async function get(key, store) {
    try { return await tx(store, 'readonly', (os) => os.get(key)) } catch (e) { return undefined }
  }
  async function set(key, value, store) {
    try { await tx(store, 'readwrite', (os) => os.put(value, key)) } catch (e) { /* ignore */ }
  }
  async function clear() {
    try {
      const db = await open()
      await new Promise((resolve, reject) => {
        const t = db.transaction(['episodes', 'works'], 'readwrite')
        t.objectStore('episodes').clear()
        t.objectStore('works').clear()
        t.oncomplete = resolve
        t.onerror = () => reject(t.error)
      })
    } catch (e) { /* ignore */ }
  }

  return { get, set, clear }
})()
