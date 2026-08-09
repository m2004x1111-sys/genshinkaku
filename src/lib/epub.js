import { Util } from './util.js'
import { Zip } from './zip.js'
import { Kakuyomu } from './kakuyomu.js'

/* client-side EPUB3 generation (zero dependencies) */
export const Epub = (() => {
  const CSS = `body { font-size: 12px; line-height: 1.9; font-family: "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif; }
h1 { font-size: 16px; }`

  function xhtmlFor(title, paragraphs) {
    const body = paragraphs.join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="ja" xml:lang="ja">
<head><meta charset="UTF-8"/><title>${Util.escapeHtml(title)}</title>
<link rel="stylesheet" href="style.css"/></head>
<body><h1>${Util.escapeHtml(title)}</h1>\n${body}\n</body>
</html>`
  }

  function navXhtml(root, manifestIds) {
    function navItems(node) {
      let html = ''
      if (node.episodes && node.episodes.length) {
        html += '<ol>\n'
        for (const ep of node.episodes) {
          const id = manifestIds[ep.episodeId]
          if (!id) continue
          html += `<li><a href="${id}.xhtml">${Util.escapeHtml(ep.title)}</a></li>\n`
        }
        html += '</ol>\n'
      }
      for (const child of node.children) {
        html += `<h3>${Util.escapeHtml(child.title)}</h3>\n${navItems(child)}`
      }
      return html
    }
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ja">
<head><meta charset="UTF-8"/><title>鐩</title></head>
<body>
<nav epub:type="toc" id="toc">
<h1>鐩</h1>
${navItems(root)}
</nav>
</body>
</html>`
  }

  function build(work, epHtmls) {
    const { meta, root } = work
    const entries = Kakuyomu.walk(root)
    const files = []
    const manifestIds = {}

    files.push({ name: 'mimetype', content: 'application/epub+zip' })

    files.push({
      name: 'META-INF/container.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    })

    let counter = 0
    for (const ep of entries) {
      const paragraphs = epHtmls.get(ep.episodeId) || []
      if (!paragraphs.length) continue
      const id = `ep${++counter}`
      manifestIds[ep.episodeId] = id
      files.push({ name: `OEBPS/${id}.xhtml`, content: xhtmlFor(ep.title, paragraphs) })
    }

    const items = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="style" href="style.css" media-type="text/css"/>`,
    ]
    const spine = []
    for (const ep of entries) {
      const id = manifestIds[ep.episodeId]
      if (!id) continue
      items.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`)
      spine.push(`<itemref idref="${id}"/>`)
    }
    const uuid = `urn:uuid:${Util.hexUUID()}`
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="ja">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${uuid}</dc:identifier>
    <dc:title>${Util.escapeHtml(meta.title)}</dc:title>
    <dc:language>ja</dc:language>
    ${meta.author ? `<dc:creator>${Util.escapeHtml(meta.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    ${items.join('\n    ')}
  </manifest>
  <spine>
    ${spine.join('\n    ')}
  </spine>
</package>`
    files.push({ name: 'OEBPS/content.opf', content: opf })

    files.push({ name: 'OEBPS/nav.xhtml', content: navXhtml(root, manifestIds) })
    files.push({ name: 'OEBPS/style.css', content: CSS })

    return Zip.build(files)
  }

  return { build }
})()
