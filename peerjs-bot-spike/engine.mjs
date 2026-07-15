// Loads the web game's browser modules into Node's VM so the bot uses the exact
// same rules and AI as the client. Imports/exports are stripped only for this
// legacy CommonJS-compatible VM boundary.
import { readFileSync, existsSync } from 'fs'
import vm from 'vm'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
// Local dev: the game scripts live in the repo root (parent dir). The Docker
// image stages them alongside this file, so prefer a sibling copy, then fall
// back to the parent.
function resolveEngineFile(file) {
  const sibling = resolve(here, file)
  return existsSync(sibling) ? sibling : resolve(here, '..', file)
}

function loadGlobalClass(file, className) {
  const src = readFileSync(resolveEngineFile(file), 'utf8')
    .replace(/^import\s+[^\n]+$/gm, '')
    .replace(/^export\s+\{[^\n]+$/gm, '')
  vm.runInThisContext(`${src}\n;globalThis.${className} = ${className};`, { filename: file })
  return globalThis[className]
}

export const ChessGame = loadGlobalClass('chess-engine.js', 'ChessGame')
export const ChessAI = loadGlobalClass('ai-engine.js', 'ChessAI')
