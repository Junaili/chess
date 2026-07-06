const assert = require('node:assert/strict')
const test = require('node:test')

test('parses the supported legal Markdown structure without producing HTML', async () => {
  const { parseLegalMarkdown } = await import('../../src/legal-markdown.mjs')
  const blocks = parseLegalMarkdown(`
# Privacy Policy

Player data is protected.

- Access your data
- Delete your account

1. Read
2. Accept
`)

  assert.deepEqual(blocks, [
    { type: 'heading', level: 1, text: 'Privacy Policy' },
    { type: 'paragraph', text: 'Player data is protected.' },
    { type: 'unordered-list', items: ['Access your data', 'Delete your account'] },
    { type: 'ordered-list', items: ['Read', 'Accept'] },
  ])
})

test('keeps HTML-looking attachment content as inert text', async () => {
  const { parseLegalMarkdown } = await import('../../src/legal-markdown.mjs')
  const blocks = parseLegalMarkdown('<img src=x onerror=alert(1)>')

  assert.deepEqual(blocks, [{
    type: 'paragraph',
    text: '<img src=x onerror=alert(1)>',
  }])
})
