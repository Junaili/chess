// Loads the web game's classic browser scripts (chess-engine.js, ai-engine.js)
// into Node so the bot uses the EXACT same rules + AI as the client — guaranteeing
// move-legality agreement over the wire. The scripts declare global classes
// (ChessGame, ChessAI); we run them in this context and capture the classes.
import { readFileSync } from 'fs'
import vm from 'vm'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function loadGlobalClass(file, className) {
  const src = readFileSync(resolve(repoRoot, file), 'utf8')
  vm.runInThisContext(`${src}\n;globalThis.${className} = ${className};`, { filename: file })
  return globalThis[className]
}

export const ChessGame = loadGlobalClass('chess-engine.js', 'ChessGame')
export const ChessAI = loadGlobalClass('ai-engine.js', 'ChessAI')
