/**
 * Behaviour test for the Context Explorer Host half.
 *
 * Folds a synthetic session log through the projection and asserts what the
 * panel draws and what its percentages are computed from: region order and
 * provenance, the token accounting behind every share, the prompt's survival
 * across a rewrite, the served fragment each region carries, the truncation flag
 * it exposes, and the estimator's agreement with the installed Harness.
 *
 * The accounting checks are the point: the client divides by `totalTokens` for
 * every share, so a figure that overlaps another makes every percentage wrong
 * while the arithmetic behind it stays self-consistent. Field presence, typing
 * and the view contract belong to tools/context-explorer.contract.mjs.
 *
 * Run: node tools/context-explorer.test.mjs
 */

import { readFileSync } from 'node:fs'
import { contextExplorerProjection } from '../index.js'
import { estimateMessage, estimateToolsTokens } from '../estimate.js'
import { MARKERS, renderToolPrompt } from '../serve.js'
import { BUNDLE } from './check-shared.mjs'

let failures = 0
let checks = 0

/** Assert one condition, reporting the exact mismatch. */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** Assert deep equality on JSON values. */
function checkEqual(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  check(label, a === b, `got ${a}, want ${b}`)
}

const { apply, init, wire } = contextExplorerProjection

/** Run a sequence of events through the fold. */
function fold(events) {
  let state = init()
  for (const event of events) state = apply(state, event)
  return { state, view: wire.view(state) }
}

/** Append one derived message as the surface event that carries it. */
function messageEvent(message, seq) {
  if (message.role === 'tool') return { type: 'tool/result', seq, surfaceOp: 'append', data: { turn: 1, step: 1, message } }
  if (message.role === 'assistant') return { type: 'assistant/message', seq, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message } }
  return { type: 'user/message', seq, surfaceOp: 'append', data: message }
}

/** Append one system/message event around a rendered prompt. */
function systemEvent(seq, message, surfaceOp = 'append', sourceEventSeqs = undefined) {
  return { type: 'system/message', seq, surfaceOp, sourceEventSeqs, data: { turn: 1, step: seq, message } }
}

/** A rendered system-prompt message carrying one text block. */
const systemMessage = (text) => ({ role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text }] })

/** One surface event per turn, starting at seq 4 (after the envelope and prompt). */
const turnEvents = (messages) => messages.map((message, index) => messageEvent(message, index + 4))

const TOOLS = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object' } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object' } },
]

const HEADER = { type: 'request/header', seq: 1, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' }, tools: TOOLS } } }
const CONTEXT = { type: 'request/context', seq: 2, data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000 } }

/** The Host's caps, read from the Host rather than restated here. */
const hostSource = readFileSync(`${BUNDLE}/index.js`, 'utf8')
const limit = Number(/const PREVIEW_LIMIT = (\d+)/.exec(hostSource)[1])
const rowLimit = Number(/const ROW_LIMIT = (\d+)/.exec(hostSource)[1])

/** Two turns around a tool round trip, ending in the injected runtime snapshot. */
const TURNS = [
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'first turn' }] },
  { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"a"}' }] },
  { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [{ type: 'text', text: 'file body' }] },
  { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'finished' }] },
  { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'second turn' }] },
  { role: 'user', source: { kind: 'runtime-context', form: 'snapshot' }, content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }] },
]

console.log('logs with no system prompt')
{
  const empty = fold([])
  check('an empty log draws nothing and prices nothing', empty.view.regions.length === 0 && empty.view.totalTokens === 0)
  const bare = fold([messageEvent({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, 1)])
  // No surviving system node means no system square, however many messages the
  // session has; the message itself is still priced.
  check('messages with no prompt draw no system square',
    bare.view.regions.every(region => region.kind !== 'system') && bare.view.totalTokens > 0)
}

console.log('request envelope, prompt, turns and a runtime-context snapshot')
{
  const prompt = systemMessage('You are an AI agent powered by DeepSeek Harness.\n\nSecond section.')
  const { view } = fold([HEADER, CONTEXT, systemEvent(3, prompt), ...turnEvents(TURNS)])
  const sum = (regions) => regions.reduce((total, region) => total + region.tokens, 0)
  const systemRegion = view.regions.find(region => region.kind === 'system')
  const toolsRegion = view.regions.find(region => region.kind === 'tools')

  checkEqual('region kinds in surface order', view.regions.map(region => region.kind), ['system', 'tools', 'user', 'assistant', 'tool', 'assistant', 'user', 'user'])
  // The client resolves a square's owner as `spans[order]`, so a gap or a
  // duplicate silently mislabels every square after it.
  check('region orders are dense and zero-based, so `spans[order]` resolves', view.regions.every((region, index) => region.order === index), view.regions.map(region => region.order).join(','))
  // `totalTokens` is what the client divides by for every share, and it is the
  // envelope plus the price of every entry — the provider's count where one
  // covers an entry, this plugin's estimate otherwise. The squares the panel
  // draws are those same figures, so they must sum to it exactly: an earlier
  // version counted the prompt twice, and every percentage was wrong while each
  // figure stayed plausible.
  check('the drawn squares sum to the total', sum(view.regions) === view.totalTokens, `${sum(view.regions)} vs ${view.totalTokens}`)
  // The envelope owns no message sequence, so no square can count it twice, and
  // no provider count covers it on its own — the difference it could be read
  // from spans a whole request, prompt included.
  check('the envelope is its own square, priced from the schemas',
    toolsRegion !== undefined && toolsRegion.kind === 'tools' && toolsRegion.seq === null
    && toolsRegion.tokens === estimateToolsTokens(TOOLS) && toolsRegion.measured === false)
  check('the system square prices the surviving prompt',
    systemRegion !== undefined && systemRegion.tokens === estimateMessage(prompt),
    `${systemRegion?.tokens} vs ${estimateMessage(prompt)}`)
}

console.log('the provider report is the last call\'s prompt, counted its own way')
{
  // The provider counts a request's prompt as the uncached input plus the cache
  // reads and writes. Its own `totalTokens` also contains the answer, so reading
  // that field would show a prompt larger than the one that was sent — the one
  // wiring mistake this reports, and it is invisible on a cache-cold call where
  // the two happen to agree.
  const usage = { inputTokens: 900, cacheReadTokens: 250, cacheWriteTokens: 50, outputTokens: 40, totalTokens: 1240 }
  const assistant = { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'finished' }] }
  const withUsage = (message, seq, report) => ({ type: 'assistant/message', seq, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message, usage: report } })
  const events = [HEADER, CONTEXT, systemEvent(3, systemMessage('a prompt')), ...turnEvents(TURNS.slice(0, 1))]

  const before = fold(events)
  const after = fold([...events, withUsage(assistant, 5, usage)])
  const assistantRegion = after.view.regions.find(region => region.seq === 5)

  const wrong = []
  if (before.view.reportPromptTokens !== 0) {
    wrong.push(`a session with no completed call reports ${before.view.reportPromptTokens}`)
  }
  if (after.view.reportPromptTokens !== 1200) wrong.push(`the report says ${after.view.reportPromptTokens}, not the 1200 the provider counted as input`)
  if (after.view.reportPromptTokens === usage.totalTokens) wrong.push('the report took the provider\'s total, which counts the answer too')
  // The answer's own size is the count the provider reported for generating it.
  if (assistantRegion === undefined || assistantRegion.measured !== true || assistantRegion.tokens !== usage.outputTokens) {
    wrong.push(`the answer's region reads ${assistantRegion?.tokens}/${assistantRegion?.measured}, not ${usage.outputTokens} measured`)
  }
  // Nothing covers the system prompt or the envelope, so both keep the estimate
  // and say so, and the squares still sum: measured where measured, estimated
  // otherwise, on one scale.
  const fixed = [
    ['system', estimateMessage(systemMessage('a prompt'))],
    ['tools', estimateToolsTokens(TOOLS)],
  ]
  for (const [kind, price] of fixed) {
    const region = after.view.regions.find(candidate => candidate.kind === kind)
    if (region === undefined || region.measured === true || region.tokens !== price) {
      wrong.push(`the ${kind} region reads ${region?.tokens}/${region?.measured}, not ${price} estimated`)
    }
  }
  const drawn = after.view.regions.reduce((total, region) => total + region.tokens, 0)
  if (drawn !== after.view.totalTokens) {
    wrong.push(`the squares stopped summing: ${drawn} vs ${after.view.totalTokens}`)
  }
  check('the report is the provider\'s own prompt count', wrong.length === 0, wrong.join('; '))

  // The window after that call holds exactly one message, so the next report
  // prices it by the difference: the prompt grew by that message alone, so its
  // price is the growth less the answer generated before it.
  const second = { inputTokens: 300, cacheReadTokens: 1200, cacheWriteTokens: 0, outputTokens: 70, totalTokens: 1570 }
  const result = { role: 'tool', source: { kind: 'tool', toolName: 'probe' }, content: [{ type: 'text', text: 'a tool result' }] }
  const priced = fold([
    ...events,
    withUsage(assistant, 5, usage),
    { type: 'tool/result', seq: 6, surfaceOp: 'append', data: { message: result } },
    withUsage(assistant, 7, second),
  ])
  const difference = priced.view.regions.find(region => region.seq === 6)
  const prompt = report => report.inputTokens + report.cacheReadTokens + report.cacheWriteTokens
  const expected = prompt(second) - prompt(usage) - usage.outputTokens
  const wrongWindow = []
  if (difference === undefined || difference.measured !== true || difference.tokens !== expected) {
    wrongWindow.push(`the window's message reads ${difference?.tokens}/${difference?.measured}, not ${expected} measured`)
  }
  const answer = priced.view.regions.find(region => region.seq === 7)
  if (answer === undefined || answer.measured !== true || answer.tokens !== second.outputTokens) {
    wrongWindow.push(`the second answer reads ${answer?.tokens}, not ${second.outputTokens}`)
  }
  // A window holding more than one message cannot be split by the difference, so
  // neither message may claim a measured price.
  const doubled = fold([
    ...events,
    withUsage(assistant, 5, usage),
    { type: 'tool/result', seq: 6, surfaceOp: 'append', data: { message: result } },
    { type: 'user/message', seq: 7, surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: 'and this' }] } },
    withUsage(assistant, 8, second),
  ])
  for (const seq of [6, 7]) {
    const region = doubled.view.regions.find(candidate => candidate.seq === seq)
    if (region === undefined || region.measured === true) wrongWindow.push(`a two-message window priced seq ${seq} from the difference`)
  }
  check('a window of one message is priced by the difference, and a wider one is not',
    wrongWindow.length === 0, wrongWindow.join('; '))
}

console.log('a usage-only answer earns no square and no share')
{
  // The Harness commits the max-tokens usage-host shape — an `assistant/message`
  // with empty content — to carry the provider's own count for a response that
  // assembled nothing. The shipped `contextBreakdown` skips it: it derives to no
  // transcript entry and adds nothing. The region list does the same. Its
  // measured output may not enter `totalTokens` either, because that figure is
  // the drawn squares summed: a total carrying a price no square draws leaves
  // the map covering less than the summary claims.
  const answer = { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [] }
  const usageOnly = { type: 'assistant/message', seq: 5, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: answer, usage: { inputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 25, totalTokens: 925 } } }
  const ask = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'ask' }] }
  const { view } = fold([HEADER, CONTEXT, systemEvent(3, systemMessage('a prompt')), messageEvent(ask, 4), usageOnly])
  const drawn = view.regions.reduce((total, region) => total + region.tokens, 0)
  const priced = estimateToolsTokens(TOOLS) + estimateMessage(systemMessage('a prompt')) + estimateMessage(ask)
  const wrong = []
  if (view.regions.some(region => region.seq === 5)) wrong.push('the usage-only answer was drawn as a region')
  if (view.totalTokens !== drawn) wrong.push(`the summary counts ${view.totalTokens} while the squares draw ${drawn}`)
  if (view.totalTokens !== priced) wrong.push(`the summary counts ${view.totalTokens} where the context holds ${priced}`)
  check('a usage-only answer earns no square and no share', wrong.length === 0, wrong.join('; '))
}

console.log('a rewritten system prompt prices the survivor')
{
  // A rewrite replaces the prompt in place; the dead node's price must not
  // survive in any figure.
  const { view } = fold([
    HEADER, CONTEXT, systemEvent(3, systemMessage('first prompt')), ...turnEvents(TURNS.slice(0, 3)),
    systemEvent(7, systemMessage('second prompt, longer than the first'), { op: 'replace', startSeq: 3, endSeq: 3 }, [3]),
  ])
  const systems = view.regions.filter(region => region.kind === 'system')
  const survivingPrice = estimateMessage(systemMessage('second prompt, longer than the first'))
  check('exactly one system region survives, and it is the replacement', systems.length === 1 && systems[0].seq === 7)
  check('the surviving prompt is priced alone', systems[0]?.tokens === survivingPrice, `${systems[0]?.tokens} vs ${survivingPrice}`)
}

console.log('a blanked system prompt stays a priced region, a block-less one does not')
{
  // The shipped estimator returns 0 only for NO content blocks; one empty text
  // block still costs ROLE_OVERHEAD, so an emptied prompt stays a minimal region.
  const first = systemEvent(1, systemMessage('prompt'))
  const cleared = systemEvent(2, systemMessage(''), { op: 'replace', startSeq: 1, endSeq: 1 }, [1])
  const blockless = systemEvent(3, { role: 'system', source: { kind: 'system-prompt' }, content: [] }, { op: 'replace', startSeq: 2, endSeq: 2 }, [2])
  const restored = systemEvent(4, systemMessage('restored'), { op: 'replace', startSeq: 3, endSeq: 3 }, [3])

  const blanked = fold([first, cleared])
  // The region still exists and still opens the prompt, so what it serves is the
  // opening token and the system marker with no body between them, priced at the
  // role overhead an empty text block still costs.
  check('a blanked prompt prices as role framing and serves its markers alone',
    blanked.view.regions[0]?.tokens === 4
    && blanked.view.regions[0]?.served === `${MARKERS.BOS}${MARKERS.SYSTEM}`)
  const gone = fold([first, cleared, blockless])
  check('a block-less prompt draws no region and prices zero', gone.view.regions.length === 0 && gone.view.totalTokens === 0)
  // The zero-token node still anchors the next rewrite: a replacement resolves
  // its range by sequence, so dropping the node would fail the whole fold.
  const back = fold([first, cleared, blockless, restored])
  check('a zero-token node still anchors a later replacement',
    back.state.failure === null && back.view.regions[0]?.tokens === estimateMessage(systemMessage('restored')))
}

console.log('the first system prompt is hoisted, every later one travels as a reminder')
{
  // Two prompts appended without replacing each other both stay on the surface.
  // The Harness hoists the FIRST system message into the request's top-level
  // `system` field and sends every later one inside `messages`, which the backend
  // wraps in `<system-reminder>` and treats as a user turn — so the opening token
  // belongs to the first prompt even though the later one is the update the model
  // actually obeys. Swapping these two is the mistake this pins.
  const first = 'a'.repeat(limit + 10)
  const { view } = fold([
    systemEvent(1, systemMessage(first)),
    systemEvent(2, systemMessage('second prompt')),
  ])
  const [hoisted, later] = [view.regions.find(entry => entry.seq === 1), view.regions.find(entry => entry.seq === 2)]
  check('the first prompt is served as the system message, the later one as the wrapped user fragment',
    view.regions.length === 2
    && hoisted.served.startsWith(`${MARKERS.BOS}${MARKERS.SYSTEM}`)
    && hoisted.served.includes(first)
    && later.served.startsWith(MARKERS.USER)
    && later.served.includes(`<system-reminder>\nsecond prompt\n</system-reminder>`))
  // A system node carries its text whole, so nothing served is clipped even
  // though the row's preview is a row: the clip flag describes what the reader
  // can expand, not what the row kept.
  check('the long prompt is a capped row but an unclipped served text',
    hoisted.preview.length === rowLimit
    && hoisted.truncated === false && later.truncated === false)
  check('each prompt keeps its own price',
    hoisted.tokens === estimateMessage(systemMessage(first))
    && later.tokens === estimateMessage(systemMessage('second prompt')),
    `${hoisted.tokens} / ${later.tokens}`)
}

console.log('unrelated events are ignored by reference')
{
  const state = init()
  check('the same state reference comes back', apply(state, { type: 'turn/start', seq: 1, data: { turn: 1 } }) === state)
}

console.log('a message region serves a capped fragment while the prompt travels whole')
{
  const long = 'x'.repeat(limit + 1000)
  const toolResult = (text, seq) => ({ type: 'tool/result', seq, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', content: [{ type: 'text', text }] } } })
  const { state, view } = fold([
    systemEvent(1, systemMessage(long)),
    toolResult(long, 2),
    // A tool CALL carries no text block, only `arguments`, so it is the one
    // message kind whose row preview depends on reading that field. Dropping it
    // would show an empty row for every tool call in the list.
    { type: 'assistant/message', seq: 3, surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'tool-call', id: 'c', name: 'read', arguments: '{"path":"probe"}' }] } } },
  ])
  const system = state.entries.find(entry => entry.kind === 'system')
  check(`the prompt keeps its whole text (${limit + 1000} chars) and the region serves all of it`,
    system.text.length === limit + 1000 && view.regions[0].served.includes(long))
  // The pieces a non-system region is served from share one budget, so the
  // fragment carries the beginning of the message and the reader is told the
  // rest is not here rather than shown a silently short text.
  check(`a message region serves the first ${limit} chars of its text and no more`,
    view.regions[1].served.includes('x'.repeat(limit))
    && !view.regions[1].served.includes('x'.repeat(limit + 1)))
  check('a tool call is previewed by its arguments, not left blank',
    view.regions[2].preview === '{"path":"probe"}', JSON.stringify(view.regions[2].preview))

  // `truncated` describes the served text, not the row's preview: the prompt
  // region serves everything and is complete while its row preview is a row, and
  // a message region whose served fragment was cut says so.
  check('the whole-text region is marked complete while its row stays a row',
    view.regions[0].truncated === false && view.regions[0].preview.length === rowLimit)
  // A text exactly the budget long is complete, so `truncated` cannot be
  // inferred from what was kept — that is the one case a reader cannot check by
  // eye, and both sides of the budget are one invariant.
  const exact = fold([systemEvent(1, systemMessage('short prompt')), toolResult('x'.repeat(limit), 2)])
  check('the clip flag describes the served text on both sides of the budget',
    view.regions[1].truncated === true
    && exact.view.regions[1].truncated === false && exact.view.regions[1].preview.length === rowLimit)
}

console.log('every region serves the fragment of the prompt its place calls for')
{
  const prompt = systemMessage('You are an AI agent powered by DeepSeek Harness.\n\nSecond section.')
  const { view } = fold([HEADER, CONTEXT, systemEvent(3, prompt), ...turnEvents(TURNS)])
  const toolsRegion = view.regions[1]

  // The session's first region opens the prompt, and the tool block is appended
  // to the system message after a blank line. It is served whole rather than as
  // a row-sized summary, and its row keeps the envelope's own serialization
  // rather than a sentence about the envelope.
  check('the session opens the prompt and serves the whole tools block',
    view.regions[0].served.startsWith(`${MARKERS.BOS}${MARKERS.SYSTEM}`)
    && view.regions[0].served.includes('Second section.')
    && toolsRegion.served === `\n\n${renderToolPrompt(TOOLS)}`
    && toolsRegion.served.startsWith('\n\n## Tools')
    && toolsRegion.preview === JSON.stringify(TOOLS).slice(0, rowLimit))

  // A session with only an envelope has no system prompt to hoist, so the tool
  // region carries the prompt's opening itself: the block is appended to a system
  // message the renderer supplies, after the blank line that separates them.
  const manyTools = Array.from({ length: 40 }, (_, index) => ({ name: `tool-${index}`, description: 'x'.repeat(200), parameters: { type: 'object' } }))
  const envelope = JSON.stringify(manyTools)
  const big = fold([{ type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' }, tools: manyTools } } }]).view.regions[0]
  check('a long envelope keeps its whole price, its whole block, and a capped row',
    envelope.length > limit && big.preview.length === rowLimit && big.tokens === estimateToolsTokens(manyTools)
    && big.truncated === false
    && big.served === `${MARKERS.BOS}${MARKERS.SYSTEM}\n\n${renderToolPrompt(manyTools)}`,
    `envelope ${envelope.length} chars, row ${big.preview.length}, served ${big.served.length}`)

  // A fragment opens with its own marker when the message before it was an
  // assistant or system message, and with the blank line that joins it to that
  // message when it was a user or tool message. The fixture runs user,
  // assistant, tool, assistant, user, snapshot, so only the snapshot joins.
  const messageRegions = view.regions.filter(region => region.seq !== null && region.kind !== 'system')
  const expected = [MARKERS.USER, MARKERS.ASSISTANT, MARKERS.USER, MARKERS.ASSISTANT, MARKERS.USER, '\n\n']
  const wrong = messageRegions
    .map((region, index) => (region.served.startsWith(expected[index])
      ? null
      : `${region.kind}: ${JSON.stringify(region.served.slice(0, 24))} where ${JSON.stringify(expected[index])} was due`))
    .filter(entry => entry !== null)
  check('a message fragment opens with the marker its place calls for', wrong.length === 0, wrong.join('; '))
}

console.log('a malformed event is contained, not thrown')
{
  // The registry drives every projection from one synchronous loop, so an
  // unanticipated shape must be recorded, not thrown, or the pass aborts.
  const broken = { type: 'user/message', seq: 7, surfaceOp: { op: 'replace', startSeq: 99, endSeq: 99 }, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'x' }] } }
  const { state, view } = fold([broken])
  check('the failure is recorded and names the event', state.failure !== null && state.failure.includes('session event 7') && view.failure === state.failure)
  check('the fold stops advancing once failed', apply(state, { type: 'user/message', seq: 8, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'y' }] } }) === state)
  check('a healthy fold reports no failure', fold([]).view.failure === null)
}

console.log('state validation rejects a corrupt checkpoint row')
{
  const parsed = (value) => { try { return contextExplorerProjection.stateSchema.parse(value) } catch { return null } }
  // The surrounding state comes from the Host's own `init()`, so this states the
  // current shape without restating it; only the entry is incomplete, which is
  // what the check is about.
  check('throws on a partial entry', parsed({ ...init(), entries: [{ seq: 1 }] }) === null)
  check('accepts its own init state', parsed(init()) !== null)
}

console.log('estimator agrees with the installed Harness copy')
{
  // The bundled estimator is a copy of a shipped one, so drift between them is
  // the failure this scenario exists to catch. It needs the installed Harness to
  // compare against, and that lives outside this repository — so a missing
  // install is reported as a skipped comparison rather than thrown, since an
  // import error here would look like a failing assertion about the code.
  const load = async () => {
    try {
      // The installed Harness is found the way any other process would find the
      // profile's packages: from the profile directory the Harness exports, or
      // from the default layout under the user's home. No name is written here,
      // so this check works on any machine.
      const { createRequire } = await import('node:module')
      const { homedir } = await import('node:os')
      const { join } = await import('node:path')
      const profileDir = process.env.DSH_PROFILE_DIR
        ?? join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'web')
      const require = createRequire(join(profileDir, 'package.json'))
      const path = require.resolve('@deepseek-ai/dsh-token-meter/estimate')
      return await import(`file:///${path.replace(/\\/g, '/')}`)
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : String(error) }
    }
  }
  const shipped = await load()
  if (shipped.unavailable !== undefined) {
    console.log(`  skip the installed Harness is not resolvable here (${shipped.unavailable.split('\n')[0]})`)
  } else {
    // One sample per pricing arm: plain text, CJK text, a tool call, an image
    // reference, and a message with no blocks at all.
    const samples = [
      { role: 'system', content: [{ type: 'text', text: 'a'.repeat(37) }] },
      { role: 'user', content: [{ type: 'text', text: 'hello 世界' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'grep', arguments: '{"pattern":"x"}' }] },
      { role: 'tool', source: { kind: 'tool', callId: 'c' }, toolCallId: 'c', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3, width: 2, height: 2 } }] },
      { role: 'user', content: [] },
    ]
    const drift = samples.flatMap((sample, index) => estimateMessage(sample) === shipped.estimateMessage(sample)
      ? [] : [`message ${index}: ${estimateMessage(sample)} vs ${shipped.estimateMessage(sample)}`])
    const toolsAgree = estimateToolsTokens(TOOLS) === shipped.estimateToolsTokens({ tools: TOOLS, config: { provider: 'p', model: 'm' } }) && estimateToolsTokens([]) === shipped.estimateToolsTokens(undefined)
    check('the bundled pricing agrees with the installed copy on every arm, and the empty set',
      drift.length === 0 && toolsAgree,
      drift.length > 0 ? drift.join('; ') : 'the tool-schema pricing differs')
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
