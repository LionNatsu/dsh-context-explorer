/**
 * Replay a real persisted Session log through the Context Explorer projection.
 *
 * This is the end-to-end check the unit tests cannot make: it proves the fold
 * survives a genuine DSH event stream (compaction replacements, snapshot
 * messages, developer tool-change messages, replayed assistant streams) and
 * that the view it produces satisfies the wire contract the browser half reads.
 *
 * Run: node tools/replay-session.mjs <session.v4.jsonl.zstd> [--verbose]
 */

import { readFileSync } from 'node:fs'
import { contextExplorerProjection } from '../index.js'
import { splitFrames } from './zstd-frames.mjs'

const path = process.argv[2]
const verbose = process.argv.includes('--verbose')
if (path === undefined) {
  console.error('usage: node tools/replay-session.mjs <session.v4.jsonl.zstd> [--verbose]')
  process.exit(2)
}

// Session logs are appended zstd frames, one per flush; a whole-file
// decompress stops after the first frame, which is only the header.
const frames = splitFrames(readFileSync(path))
const raw = frames.map(frame => frame.toString('utf8')).join('')
const events = raw.split('\n').filter(line => line.trim().length > 0).map((line) => {
  const record = JSON.parse(line)
  return record.event ?? record
})

console.log(`replaying ${events.length} committed events\n`)

let state = contextExplorerProjection.init()
let applied = 0
let changed = 0
for (const event of events) {
  const next = contextExplorerProjection.apply(state, event)
  applied += 1
  if (next !== state) changed += 1
  state = next
}

const view = contextExplorerProjection.wire.view(state)
contextExplorerProjection.wire.viewSchema.parse(view)
const persisted = contextExplorerProjection.stateSchema.parse(JSON.parse(JSON.stringify(state)))

console.log(`events applied          ${applied}`)
console.log(`events that changed it  ${changed}`)
console.log(`log watermark           ${state.asOf}`)
console.log(`retained entries        ${persisted.entries.length}`)
console.log(`context window          ${view.contextWindow ?? '(none)'}`)
console.log('')
console.log(`provider reported       ${view.reportPromptTokens} tokens for the last request`)
console.log(`panel total             ${view.totalTokens} tokens`)
const measured = view.regions.filter(region => region.measured)
console.log(`  measured regions      ${measured.length} of ${view.regions.length} (${measured.reduce((sum, region) => sum + region.tokens, 0)} tokens)`)
console.log('')
console.log(`regions drawn           ${view.regions.length}`)
const byKind = new Map()
for (const region of view.regions) {
  const row = byKind.get(region.kind) ?? { count: 0, tokens: 0 }
  row.count += 1
  row.tokens += region.tokens
  byKind.set(region.kind, row)
}
for (const [kind, row] of [...byKind].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(`  ${kind.padEnd(12)} ${String(row.count).padStart(5)} regions  ${String(row.tokens).padStart(8)} tokens`)
}

const heaviest = [...view.regions].sort((a, b) => b.tokens - a.tokens).slice(0, 8)
console.log('')
console.log('heaviest regions:')
for (const region of heaviest) {
  const share = view.totalTokens === 0 ? 0 : (region.tokens / view.totalTokens) * 100
  const preview = region.preview.replace(/\s+/g, ' ').slice(0, 60)
  console.log(`  ${region.kind.padEnd(10)} ${String(region.tokens).padStart(7)} tok ${share.toFixed(1).padStart(5)}%  ${preview}`)
}

if (verbose) {
  console.log('')
  console.log('all regions in model-visible order:')
  for (const region of view.regions) {
    console.log(`  ${String(region.order).padStart(4)} seq=${region.seq === null ? '  -' : String(region.seq).padStart(4)} ${region.kind.padEnd(10)} ${String(region.tokens).padStart(7)} tok  ${region.preview.replace(/\s+/g, ' ').slice(0, 50)}`)
  }
}

console.log('\nview satisfies the wire contract; state survives a JSON round trip.')
