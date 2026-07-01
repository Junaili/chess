// Loads the web game's classic browser scripts (chess-engine.js, ai-engine.js)
// into Node so the bot uses the EXACT same rules + AI as the client — guaranteeing
// move-legality agreement over the wire. The scripts declare global classes
// (ChessGame, ChessAI); we run them in this context and capture the classes.
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
  vm.runInThisContext(`${src}\n;globalThis.${className} = ${className};`, { filename: file })
  return globalThis[className]
}

export const ChessGame = loadGlobalClass('chess-engine.js', 'ChessGame')
export const ChessAI = loadGlobalClass('ai-engine.js', 'ChessAI')
