// Generates public/legal/index.html FROM legal-documents/*.md — the same
// markdown source provisioned into AGS Legal (scripts/provision-ags-legal.mjs)
// and click-through-accepted by players. Previously this page was a hand-
// maintained duplicate of that content, which drifted from what AGS actually
// serves (found: the Terms section was missing a sentence present in the
// AGS-tracked version). Regenerating from the same source on every build
// makes that drift structurally impossible.
//
// Run via `npm run legal:generate`, or automatically as part of `npm run build`.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'legal-documents/manifest.json'), 'utf8'))

// Page sections in display order. The AGS-tracked policies come from the
// manifest (kept as the single source shared with provisioning); "support" is
// page-only — contact/help content, not a document players accept — so it
// lives in its own markdown file without being part of the AGS provisioning list.
const sections = [
  // titleOverride: the AGS-tracked policies show their short policyName
  // ("Privacy Policy") on the acceptance screen, not the markdown's full H1
  // ("Ethan's Chess Privacy Policy") — use the same short name here so the
  // public page matches what players actually see and accept in-app.
  ...manifest.documents.map(doc => ({ key: doc.key, source: doc.source, titleOverride: doc.policyName })),
  { key: 'support', source: 'support.md' },
]

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Inline formatting: **bold**, [text](url) links, and bare https:// URLs
// auto-linked. Legal sources may also use a mailto: link for support contact.
function renderInline(text) {
  let html = escapeHtml(text)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/g, (_m, label, url) =>
    `<a href="${url}" rel="noopener noreferrer">${label}</a>`,
  )
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+?)([.,;:!?)]?(?=\s|$))/g, (_m, pre, url) =>
    `${pre}<a href="${url}" rel="noopener noreferrer">${url}</a>`,
  )
  return html
}

// Minimal block-level parser for the narrow markdown subset these documents
// use: a leading H1 (title), a one-line "eyebrow" paragraph directly under it,
// then ##-headings, paragraphs, and -/1. lists. Nothing else is needed here —
// this is not a general-purpose markdown renderer.
function parseDocument(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').trim().split('\n')
  if (!lines[0]?.startsWith('# ')) throw new Error('Document must start with a level-1 heading.')
  const title = lines[0].slice(2).trim()

  const rest = lines.slice(1).join('\n').trim()
  const blocks = rest.split(/\n{2,}/).map(b => b.trim()).filter(Boolean)
  const eyebrow = blocks.shift() || ''

  const bodyHtml = blocks.map(block => {
    const blockLines = block.split('\n')
    if (blockLines[0].startsWith('## ')) {
      return `<h3>${renderInline(blockLines[0].slice(3).trim())}</h3>`
    }
    if (blockLines.every(l => /^-\s+/.test(l))) {
      const items = blockLines.map(l => `<li>${renderInline(l.replace(/^-\s+/, ''))}</li>`).join('\n        ')
      return `<ul>\n        ${items}\n      </ul>`
    }
    if (blockLines.every(l => /^\d+\.\s+/.test(l))) {
      const items = blockLines.map(l => `<li>${renderInline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('\n        ')
      return `<ol>\n        ${items}\n      </ol>`
    }
    // A paragraph that is a single markdown link, alone, is a call-to-action —
    // render as the page's styled button instead of a plain inline link.
    const soleLink = block.match(/^\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)$/)
    if (soleLink) {
      return `<p><a class="support-button" href="${soleLink[2]}" rel="noopener noreferrer">${escapeHtml(soleLink[1])}</a></p>`
    }
    return `<p>${renderInline(block.replace(/\n/g, ' '))}</p>`
  }).join('\n\n      ')

  return { title, eyebrow, bodyHtml }
}

const renderedSections = await Promise.all(sections.map(async ({ key, source, titleOverride }) => {
  const markdown = await readFile(resolve(root, 'legal-documents', source), 'utf8')
  const { title, eyebrow, bodyHtml } = parseDocument(markdown)
  return `    <section id="${key}">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h2>${escapeHtml(titleOverride || title)}</h2>
      ${bodyHtml}
    </section>`
}))

const navLabels = { privacy: 'Privacy', terms: 'Terms', community: 'Community', support: 'Support' }
const nav = sections.map(({ key }) => `<a href="#${key}">${navLabels[key] || key}</a>`).join('\n        ')

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="dark" />
  <title>Ethan's Chess — Privacy, Terms, Community, and Support</title>
  <link rel="stylesheet" href="legal.css" />
</head>
<body>
  <main>
    <header>
      <p class="eyebrow">Ethan's Chess</p>
      <h1>Legal, privacy, and support</h1>
      <nav aria-label="Legal documents">
        ${nav}
      </nav>
    </header>

${renderedSections.join('\n\n')}
  </main>
</body>
</html>
`

const outPath = resolve(root, 'public/legal/index.html')
await writeFile(outPath, html)
console.log(`Generated public/legal/index.html from legal-documents/*.md (${sections.length} sections).`)
