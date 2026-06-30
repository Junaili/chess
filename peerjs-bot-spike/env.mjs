// Minimal .env loader (no dependency). Loads ./.env into process.env without
// overriding anything already set in the real environment.
import { readFileSync } from 'fs'

try {
  const text = readFileSync(new URL('./.env', import.meta.url), 'utf8')
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {
  // no .env file — rely on the real environment
}
