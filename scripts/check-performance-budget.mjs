import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST_DIR = new URL('../dist/', import.meta.url)
const html = readFileSync(new URL('index.html', DIST_DIR), 'utf8')
const entryMatches = [...html.matchAll(/<script[^>]+type=["']module["'][^>]+src=["']([^"']+)["']/g)]
const preloadMatches = [...html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/g)]

if (entryMatches.length !== 1) {
  throw new Error(`Expected exactly one launch module, found ${entryMatches.length}`)
}

const launchUrls = [...entryMatches, ...preloadMatches].map(match => match[1])
const launchFiles = launchUrls.map(url => {
  const relativePath = url.replace(/^https?:\/\/[^/]+\//, '').replace(/^\/chess\//, '').replace(/^\.\//, '')
  const fileUrl = new URL(relativePath, DIST_DIR)
  const contents = readFileSync(fileUrl)
  return {
    asset: relativePath,
    rawBytes: statSync(fileUrl).size,
    gzipBytes: gzipSync(contents, { level: 9 }).length,
  }
})

const forbiddenEagerPattern = /(auth|ags-client|session|presence|friends|chat|matchmaking|leaderboard|stats|cloudsave|iam|lobby)/i
const forbiddenEagerAssets = launchFiles.filter(file => forbiddenEagerPattern.test(basename(file.asset)))
const totals = launchFiles.reduce((sum, file) => ({
  rawBytes: sum.rawBytes + file.rawBytes,
  gzipBytes: sum.gzipBytes + file.gzipBytes,
}), { rawBytes: 0, gzipBytes: 0 })
// Raised from 220/70 KiB during the History+Journal learning-loop build-out
// (dev-plan M0-M4): the eager wiring for six rollout flags, spectator mode/
// orientation, and History enrichment left only ~2.7 KiB gzip of headroom
// with M5-M7 (practice queue, goals, Journal hierarchy) still to land. Most
// of that work lands in already-lazy chunks (journal.js, review.js), so this
// gives real margin without expecting to need it all.
const limits = { rawBytes: 260 * 1024, gzipBytes: 85 * 1024 }
const report = {
  commit: process.env.GITHUB_SHA || 'local',
  generatedAt: new Date().toISOString(),
  limits,
  totals,
  launchFiles,
  forbiddenEagerAssets: forbiddenEagerAssets.map(file => file.asset),
}

writeFileSync(new URL('../performance-budget.json', import.meta.url), `${JSON.stringify(report, null, 2)}\n`)

const kib = bytes => `${(bytes / 1024).toFixed(2)} KiB`
const summary = [
  '### Launch performance budget',
  '',
  `- JavaScript: ${kib(totals.rawBytes)} / ${kib(limits.rawBytes)} raw`,
  `- Compressed: ${kib(totals.gzipBytes)} / ${kib(limits.gzipBytes)} gzip`,
  `- Launch modules: ${launchFiles.map(file => file.asset).join(', ')}`,
  `- Eager authenticated chunks: ${forbiddenEagerAssets.length ? forbiddenEagerAssets.map(file => file.asset).join(', ') : 'none'}`,
  '',
].join('\n')

process.stdout.write(`${summary}\n`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)

const failures = []
if (totals.rawBytes > limits.rawBytes) failures.push(`raw launch JS is ${kib(totals.rawBytes)} (limit ${kib(limits.rawBytes)})`)
if (totals.gzipBytes > limits.gzipBytes) failures.push(`gzip launch JS is ${kib(totals.gzipBytes)} (limit ${kib(limits.gzipBytes)})`)
if (forbiddenEagerAssets.length) failures.push(`authenticated chunks are eager: ${forbiddenEagerAssets.map(file => file.asset).join(', ')}`)
if (failures.length) throw new Error(`Performance budget failed: ${failures.join('; ')}`)
