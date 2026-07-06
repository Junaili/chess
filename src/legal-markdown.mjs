export function parseLegalMarkdown(source) {
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let list = null

  const flushParagraph = () => {
    const text = paragraph.join(' ').trim()
    if (text) blocks.push({ type: 'paragraph', text })
    paragraph = []
  }
  const flushList = () => {
    if (list?.items.length) blocks.push(list)
    list = null
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    const heading = /^(#{1,4})\s+(.+)$/.exec(line)
    const unordered = /^[-*]\s+(.+)$/.exec(line)
    const ordered = /^\d+\.\s+(.+)$/.exec(line)

    if (heading) {
      flushParagraph()
      flushList()
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
    } else if (unordered || ordered) {
      flushParagraph()
      const type = ordered ? 'ordered-list' : 'unordered-list'
      if (list?.type !== type) {
        flushList()
        list = { type, items: [] }
      }
      list.items.push((ordered || unordered)[1].trim())
    } else if (!line) {
      flushParagraph()
      flushList()
    } else {
      flushList()
      paragraph.push(line)
    }
  }

  flushParagraph()
  flushList()
  return blocks
}
