import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSLATION_CATALOG } from '../src/locales/catalog.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'localization/translation-review.csv')
const columns = ['key', 'context', 'english', 'indonesian', 'malay', 'simplified_chinese', 'status']
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`
const rows = TRANSLATION_CATALOG.map(item => [
  item.key,
  item.context,
  item.en,
  item.id,
  item.ms,
  item['zh-CN'],
  item.status,
])

await mkdir(dirname(output), { recursive: true })
await writeFile(output, [columns, ...rows].map(row => row.map(csvCell).join(',')).join('\n') + '\n')
console.log(`Wrote ${rows.length} translation rows to ${output}`)
