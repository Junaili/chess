// Bot strength benchmark. Every change that claims to make Gus or Fiona
// stronger should show a head-to-head gain here before it ships — self-play
// results are the only cheap evidence we have, since real games arrive a
// handful a day and the opponent varies.
//
//   node bench.mjs                      # depth report + default head-to-head
//   node bench.mjs --games 20           # longer match
//   node bench.mjs --depth-only         # skip the (slow) head-to-head
//   node bench.mjs --a "medium,220,off" --b "hard,2350,on"
//
// Config format: "<difficulty>,<budgetMs>,<on|off quiescence>".
import { ChessGame, ChessAI } from './engine.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const has = name => args.includes(`--${name}`)

const parseConfig = (spec, label) => {
  const [difficulty, budget, quiesce] = spec.split(',').map(s => s.trim())
  if (!['easy', 'medium', 'hard'].includes(difficulty)) {
    throw new Error(`${label}: bad difficulty ${difficulty}`)
  }
  return {
    label: spec,
    difficulty,
    opts: {
      timeBudgetMs: Number(budget) || 220,
      maxNodes: 250000,
      quiescence: quiesce === 'on',
    },
  }
}

const A = parseConfig(flag('a', 'medium,220,off'), 'A')
const B = parseConfig(flag('b', 'hard,2350,on'), 'B')
const GAMES = Number(flag('games', 12))
const PLY_CAP = Number(flag('ply-cap', 120))

const ai = new ChessAI()
const isOver = g => g.status === 'checkmate' || g.status === 'stalemate' || g.status.startsWith('draw-')

// Vary the opening so the sample isn't one line repeated.
function openingPosition(seed, plies) {
  const g = new ChessGame()
  for (let i = 0; i < plies; i++) {
    const moves = g.getAllLegalMoves(g.currentTurn)
    if (!moves.length) break
    const m = moves[(seed * (i + 3) + i * 5) % moves.length]
    g.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')
    if (isOver(g)) break
  }
  return g
}

function depthReport(configs) {
  const positions = [0, 1, 2, 3].map(s => openingPosition(s + 4, 10 + s * 6))
  console.log('\nconfig                     depth   nodes     ms')
  for (const c of configs) {
    let depth = 0, nodes = 0, ms = 0, n = 0
    for (const g of positions) {
      const t0 = Date.now()
      ai.getBestMove(g, c.difficulty, c.opts)
      ms += Date.now() - t0
      depth += ai.lastSearch.completedDepth
      nodes += ai.lastSearch.nodes
      n++
    }
    console.log(
      c.label.padEnd(26) +
      (depth / n).toFixed(2).padEnd(8) +
      Math.round(nodes / n).toString().padEnd(10) +
      (ms / n).toFixed(0)
    )
  }
}

function headToHead(a, b, games, plyCap) {
  let aWins = 0, bWins = 0, drawn = 0
  for (let i = 0; i < games; i++) {
    const g = openingPosition(i * 3 + 1, 4)
    const aIsWhite = i % 2 === 0
    let ply = 0
    while (ply < plyCap && !isOver(g)) {
      const cfg = (g.currentTurn === 'white') === aIsWhite ? a : b
      const m = ai.getBestMove(g, cfg.difficulty, cfg.opts)
      if (!m) break
      g.makeMove(m.fr, m.fc, m.toR, m.toC, m.promType || 'queen')
      ply++
    }
    if (g.status === 'checkmate') {
      if ((g.winner === 'white') === aIsWhite) aWins++
      else bWins++
    } else {
      drawn++
    }
    process.stdout.write(`  game ${i + 1}/${games}: ${g.status}${g.winner ? ' ' + g.winner : ''}\n`)
  }
  return { aWins, bWins, drawn }
}

console.log(`A = ${A.label}\nB = ${B.label}`)
depthReport([A, B])

if (!has('depth-only')) {
  console.log(`\nhead-to-head, ${GAMES} games, alternating colours, ${PLY_CAP}-ply cap:`)
  const { aWins, bWins, drawn } = headToHead(A, B, GAMES, PLY_CAP)
  console.log(`\nA (${A.label}): ${aWins}   B (${B.label}): ${bWins}   drawn/unfinished: ${drawn}`)
  if (aWins + bWins > 0) {
    const share = (bWins / (aWins + bWins)) * 100
    console.log(`B won ${share.toFixed(0)}% of decisive games.`)
  }
}
