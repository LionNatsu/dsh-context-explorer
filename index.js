/**
 * Context Explorer (Host half).
 *
 * Registers one `sessionProjections` unit that folds a Session's committed log
 * into the composition of the context its next request submits: the rendered
 * system prompt, the current tool-schema envelope, and every derived message in
 * model-visible order.
 *
 * A region's kind is the derived message's own role, never a package-name table,
 * so a Harness version that adds a context contributor shows up here without a
 * change to this plugin. Its size is the provider's own count where a report
 * covers the region and this plugin's estimate otherwise.
 *
 * Each region also carries its own fragment of the prompt text the DeepSeek
 * backend builds for that request, so the panel shows what the model reads
 * rather than this plugin's summary of it. `serve.js` renders that text, and
 * `tools/prompt-golden.mjs` checks it against the official encoder.
 *
 * The unit carries no imports beyond its siblings `estimate.js` and `serve.js`,
 * which is what lets a profile install it as a linked workspace directory. The
 * projection view is a pure function of the folded state, as
 * `sessionProjections` requires of every unit.
 *
 * @module dsh-context-explorer
 */

import { estimateMessage, estimateToolsTokens } from './estimate.js'
import { renderFragment, renderToolPrompt, MARKERS } from './serve.js'

/**
 * Widest served text the wire carries for one message region, in UTF-16 code
 * units. The whole of it is the prompt fragment the backend renders for that
 * message, cut where it is longer than this.
 *
 * The two fixed blocks are exempt and travel whole, because each exists once per
 * request rather than once per message: the surviving system prompt (its section
 * boundaries exist nowhere else) and the tool block.
 */
const PREVIEW_LIMIT = 4000

/**
 * Characters of a region's flat text a list row carries.
 *
 * A row renders one line and its tooltip is bounded by the same number, so this
 * is the whole of the row's material; the served text above is what the panel
 * shows when the row is opened.
 */
const ROW_LIMIT = 400

/**
 * Bumped whenever the serialized state fields or the fold semantics below change.
 * The version tracks what a persisted checkpoint carries, so an older checkpoint
 * is dropped rather than read through fields that have since moved.
 */
const STATE_VERSION = 7

/** Model-visible surface event types; a non-surface event contributes no message. */
const SURFACE_EVENT_TYPES = new Set([
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'tool/result',
])

/** Content block types that carry their own priceable text. */
const TEXT_BLOCKS = new Set(['text', 'reasoning'])

/** Concatenate the text a message's blocks carry, with no invented separator. */
function textOfContent(content) {
  let text = ''
  for (const block of content) {
    if (TEXT_BLOCKS.has(block.type)) text += block.text
    else if (block.type === 'tool-call') text += block.arguments
  }
  return text
}

/** The marker the backend writes where a message carries an image. */
const IMAGE_TOKEN = '<｜image｜>'

/**
 * The pieces the served prompt is built from, in the order it writes them.
 *
 * A message's text, its reasoning and its tool calls are separate pieces because
 * the prompt separates them with markers; one flattened string cannot be split
 * back into them. They spend one shared budget in the order the prompt spends
 * it, so a fragment stays within `PREVIEW_LIMIT` however long a turn's reasoning
 * was, and the leading piece is the one that survives a cut.
 * @param content - the derived message's content blocks.
 * @param budget - characters the pieces may use together.
 * @returns `reasoning`, `text` and `calls`, each already cut to fit.
 */
function servedPieces(content, budget) {
  const reasoningText = content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n\n')
  // Text and images share the body, in block order: the adapter turns each one
  // into its own message and the backend joins them with a blank line.
  const textText = content
    .filter(block => block.type === 'text' || block.type === 'image')
    .map(block => (block.type === 'text' ? block.text : IMAGE_TOKEN))
    .join('\n\n')
  let left = budget
  let cutReasoning = false
  let cutText = false
  const cut = (text, mark) => {
    const kept = text.slice(0, Math.max(0, left))
    if (kept.length < text.length) mark()
    left -= kept.length
    return kept
  }
  const reasoning = cut(reasoningText, () => { cutReasoning = true })
  const text = cut(textText, () => { cutText = true })
  // Tool calls come last, as they do in the prompt, and a call whose arguments
  // did not fit is left out rather than rendered empty. A call that fits only in
  // part is shortened too, so a fragment stopping mid-JSON is marked like any
  // other prefix.
  const calls = []
  let cutCalls = false
  for (const block of content) {
    if (block.type !== 'tool-call') continue
    if (left <= 0) {
      cutCalls = true
      continue
    }
    calls.push({ name: block.name, arguments: cut(block.arguments, () => { cutCalls = true }) })
  }
  return { reasoning, text, calls, cutReasoning, cutText, cutCalls }
}

/** Whether one committed event entered the model-visible surface. */
function isSurfaceEvent(event) {
  if (!SURFACE_EVENT_TYPES.has(event.type)) return false
  return event.surfaceOp !== undefined
}

/** Widest text whose JSON is worth reading as a summary rather than as a line. */
const SUMMARY_JSON_LIMIT = 8192

/** Collapse whitespace and cut to the row's budget. */
function oneLine(text) {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > ROW_LIMIT ? `${collapsed.slice(0, ROW_LIMIT - 1)}…` : collapsed
}

/** Whether one line is nothing but JSON punctuation, and so says nothing alone. */
function isBarePunctuation(line) {
  return /^[[\]{},;:]+$/.test(line)
}

/** The first line that carries words, for text whose shape is not JSON. */
function firstMeaningfulLine(text) {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !isBarePunctuation(trimmed)) return trimmed
  }
  return ''
}

/** A scalar shown as `key: value`, or null for a value that is not one. */
function scalarOf(value) {
  if (typeof value === 'string') return oneLine(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value === null) return 'null'
  return null
}

/**
 * Read one JSON payload as a line a reader can scan.
 *
 * Tool results are usually JSON, and their first characters (`{"messageId":…`)
 * say nothing about what happened. The row therefore names the first few scalar
 * fields instead, keeping nested values out of the summary. The region's own
 * text is untouched: a reader who opens the row still sees exactly what the
 * model received.
 * @param text - the region's flat text.
 * @returns the summary, or null when the text is not a JSON payload to read.
 */
function summarizeJson(text) {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed.length > SUMMARY_JSON_LIMIT) return null
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  let payload
  try {
    payload = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (Array.isArray(payload)) {
    const first = payload.length === 0 ? null : scalarOf(payload[0])
    return first === null ? `[${payload.length}]` : `[${payload.length}] ${first}`
  }
  if (typeof payload !== 'object' || payload === null) return null
  const fields = []
  for (const [key, value] of Object.entries(payload)) {
    const scalar = scalarOf(value)
    if (scalar !== null) fields.push(`${key}: ${scalar}`)
    if (fields.length === 3) break
  }
  return fields.length === 0 ? null : fields.join(' · ')
}

/**
 * Name the calls an assistant turn made, with the first scalar argument of a
 * lone call: `list_agents` alone, `edit(D:\repo\…\package.json)` with a target.
 */
function summarizeCalls(calls) {
  if (calls.length === 0) return null
  if (calls.length > 1) return calls.map(call => call.name).join(' · ')
  const call = calls[0]
  let hint = null
  try {
    const parsed = JSON.parse(call.arguments)
    if (typeof parsed === 'object' && parsed !== null) {
      for (const value of Object.values(parsed)) {
        const scalar = scalarOf(value)
        if (scalar !== null) {
          hint = scalar
          break
        }
      }
    } else {
      hint = scalarOf(parsed)
    }
  } catch {
    hint = call.arguments.trim() === '' ? null : oneLine(call.arguments)
  }
  return hint === null ? call.name : `${call.name}(${hint})`
}

/**
 * The one line a list row carries.
 *
 * A row has to answer "what is this region" before it is opened: a call with no
 * arguments reads as `{}` otherwise, and a JSON result as `{"messageId":…`.
 * So a turn whose whole content is tool calls is named by those calls, JSON is
 * read as its leading scalar fields, and anything else is its first line of
 * prose.
 * @param flat - the region's whole flat text.
 * @param calls - the tool calls the message carried.
 * @param hasProse - whether the message also carried text or reasoning.
 * @returns the row's text.
 */
function rowTextOf(flat, calls, hasProse) {
  if (!hasProse && calls.length > 0) return oneLine(summarizeCalls(calls) ?? '')
  const json = summarizeJson(flat)
  if (json !== null) return json
  const line = oneLine(firstMeaningfulLine(flat))
  if (line !== '') return line
  return oneLine(summarizeCalls(calls) ?? '')
}

/**
 * The message one event derives to, mirroring the Session's own projection for
 * the original-content case: a live message projection applies only to model
 * input, which this unit does not reconstruct.
 * @param event - the committed session event.
 * @returns the derived message, or null when the event produces none.
 */
function deriveEventMessage(event) {
  switch (event.type) {
    case 'user/message':
      return event.data
    case 'system/message':
    case 'developer/message':
    case 'assistant/message':
      return event.data.message.content.length === 0 ? null : event.data.message
    case 'tool/result':
      return event.data.message
    default:
      return null
  }
}

/** Whether a message carried text or reasoning of its own, beyond any calls. */
function hasProse(content) {
  return content.some(block => (block.type === 'text' || block.type === 'reasoning') && block.text.trim() !== '')
}

/**
 * Read one derived message through the fields the layout needs.
 *
 * A node whose event derives no message is still a surface node: it occupies
 * its sequence and a later replacement names that sequence as its range. The
 * Harness's own meter keeps exactly this distinction — it prices such a node at
 * zero and keeps it in the surface list — so this returns a zero-token entry
 * rather than dropping the node.
 * @param seq - the surface node's sequence.
 * @param message - the derived message, or null when the event produces none.
 * @returns the priced entry.
 */
function describeNode(seq, message) {
  if (message === null) {
    return {
      seq,
      kind: 'empty',
      tokens: 0,
      reported: null,
      preview: '',
      reasoning: '',
      text: '',
      calls: [],
      cutReasoning: false,
      cutText: false,
      cutCalls: false,
    }
  }
  const flat = textOfContent(message.content)
  const system = message.role === 'system'
  // The rendered prompt is carried whole: its section boundaries exist nowhere
  // else, and the region that draws it is the one place a reader can see the
  // complete text.
  const pieces = system
    ? { reasoning: '', text: flat, calls: [], cutReasoning: false, cutText: false, cutCalls: false }
    : servedPieces(message.content, PREVIEW_LIMIT)
  return {
    seq,
    kind: typeof message.role === 'string' ? message.role : 'other',
    tokens: estimateMessage(message),
    // What the provider counted for this region, once a later request reports
    // one; null while the only figure available is the estimate above.
    reported: null,
    // The row's own one-line material, and the pieces the served fragment is
    // built from. `preview` is a summary a reader can scan — the calls a turn
    // made, the leading fields of a JSON result, or a first line of prose — while
    // the pieces keep the boundaries the prompt marks, which a flat string cannot
    // recover. What the budget cut is recorded per piece rather than as a
    // finished flag, because whether a piece is written at all depends on the
    // thinking mode in force when the region is drawn, not on the mode now.
    preview: rowTextOf(flat, pieces.calls, hasProse(message.content)),
    reasoning: pieces.reasoning,
    text: pieces.text,
    calls: pieces.calls,
    cutReasoning: pieces.cutReasoning,
    cutText: pieces.cutText,
    cutCalls: pieces.cutCalls,
  }
}

/**
 * Fold one surface transition, mirroring the meter's plan/commit pair so the
 * replacement arithmetic matches the shipped projection exactly.
 *
 * Every surface event contributes exactly one node, including one that derives
 * no message: the Harness removes a shadowed range from the surface when it
 * commits a replacement, and a zero-token node left behind by a rewrite is
 * still the node a later replacement resolves against.
 * @param entries - the priced entries preceding this event.
 * @param event - the surface event to place.
 * @returns the next entry list.
 */
function applySurface(entries, event) {
  const entry = describeNode(event.seq, deriveEventMessage(event))
  const op = event.surfaceOp
  if (op === 'append') return [...entries, entry]
  const startIdx = entries.findIndex(candidate => candidate.seq === op.startSeq)
  const endIdx = entries.findIndex(candidate => candidate.seq === op.endSeq)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error(`context explorer: replace at seq ${event.seq} has invalid current range ${op.startSeq}-${op.endSeq}`)
  }
  return [...entries.slice(0, startIdx), entry, ...entries.slice(endIdx + 1)]
}

/**
 * The system entry the request hoists: the first one in surface order.
 *
 * The Harness sends the first system message of a conversation as the request's
 * top-level `system` field, and every later one inside `messages`, which the
 * backend then wraps in `<system-reminder>` as a user turn. That is the order
 * this must follow, and it is why a prompt update appended after the history
 * reads as a reminder rather than as a second `<｜System｜>` block: the update is
 * the prompt the model obeys, but it is not the prompt the `system` field holds.
 */
function hoistedSystem(entries) {
  return entries.find(entry => entry.kind === 'system')
}

/**
 * The message the backend receives for one entry.
 *
 * Only the hoisted prompt reaches the model as a system message. The Harness
 * sends every other system entry — and a developer message — inside `messages`,
 * which the backend wraps in `<system-reminder>` and treats as a user turn, so
 * that is what the panel shows for them.
 * @param entry - the priced entry to publish.
 * @returns the message, in the conversation vocabulary the renderer takes.
 */
function servedMessageOf(entry) {
  if (entry.kind === 'system' || entry.kind === 'developer') {
    return { role: 'user', content: `<system-reminder>\n${entry.text}\n</system-reminder>` }
  }
  if (entry.kind === 'assistant') {
    return { role: 'assistant', content: entry.text, reasoning: entry.reasoning, toolCalls: entry.calls }
  }
  if (entry.kind === 'tool') return { role: 'tool', content: entry.text }
  return { role: 'user', content: entry.text }
}

/**
 * Whether what a reader opens is a prefix of the region rather than all of it.
 *
 * Decided where the fragment is drawn, not where it was folded: chat mode writes
 * no reasoning, so reasoning the budget shortened cannot mark a region clipped
 * in a conversation that never renders it.
 */
function clippedOf(entry, thinking) {
  return entry.cutText || entry.cutCalls || (thinking && entry.cutReasoning)
}

/** The price a reader sees: what the provider measured, else this plugin's estimate. */
function pricedOf(entry) {
  return entry.reported === null ? entry.tokens : entry.reported
}

/**
 * Whether a surface node is drawn as a region.
 *
 * A node that derives no message replaces nothing the model can see, so it earns
 * no square, no row and no figure — and the total must skip exactly these, or the
 * summary would count tokens no square draws.
 */
function earnsRegion(entry) {
  return entry.tokens > 0
}

/** Copy one entry of a surface list with a field replaced. */
function patchEntry(entries, seq, patch) {
  const index = entries.findIndex(entry => entry.seq === seq)
  if (index === -1) return entries
  return [...entries.slice(0, index), { ...entries[index], ...patch }, ...entries.slice(index + 1)]
}

/**
 * One drawn region, copied out of a priced entry in the field order the wire has
 * always carried.
 *
 * `served` is the region's own fragment of the prompt the backend renders, with
 * its markers: a caller draws what the model reads instead of a summary of it.
 * `preview` is the flat one-line material a list row uses.
 * @param entry - the priced entry to publish.
 * @param order - the region's position in the model-visible order.
 * @param served - the region's fragment of the served prompt.
 * @param truncated - whether that fragment is a prefix of the region.
 * @returns the region as the client receives it.
 */
function regionOf(entry, order, served, truncated) {
  return {
    order,
    seq: entry.seq,
    kind: entry.kind,
    // Measured when the provider's own count covers this region, otherwise this
    // plugin's estimate; `measured` says which, so a caller can mark the estimate.
    tokens: pricedOf(entry),
    measured: entry.reported !== null,
    preview: entry.preview,
    truncated,
    served,
  }
}

/**
 * Build the client view from the folded state.
 *
 * `Object.is` on this result is what suppresses publication, so a fresh object
 * per call is expected and the framework's two-slot buffer compares it against
 * the previous one.
 * @param state - the folded state.
 * @returns the whole current value for this projection key.
 */
function viewOf(state) {
  const system = hoistedSystem(state.entries)
  const thinking = state.thinking === true
  const effort = state.effort === '' ? undefined : state.effort
  // The message list the backend sees, in order. The tool block is not in it:
  // the renderer gives that block a system message of its own when the
  // conversation has none, and appends it to the one above otherwise, so the
  // panel draws it as its own region either way.
  const host = system !== undefined
    ? { role: 'system', content: system.text }
    : (state.toolCount > 0 ? { role: 'system', content: '' } : undefined)
  const servedMessages = []
  if (host !== undefined) servedMessages.push(host)
  const servedEntries = []
  for (const entry of state.entries) {
    if (entry === system) continue
    if (!earnsRegion(entry)) continue
    servedEntries.push(entry)
    servedMessages.push(servedMessageOf(entry))
  }
  const fragments = servedMessages.map((message, index) => renderFragment(message, {
    first: index === 0,
    previous: index === 0 ? undefined : servedMessages[index - 1],
    thinking,
    effort,
  }))
  // The prompt's opening, which belongs to whichever region draws the host: the
  // system region when one survived, the tool region when only the block exists.
  const head = host === undefined ? '' : `${MARKERS.BOS}${fragments[0]}`
  const regions = []
  let order = 0
  if (system !== undefined) {
    // The rendered prompt is one string whose section boundaries exist nowhere
    // else, so this region carries it whole.
    regions.push(regionOf(system, order++, head, clippedOf(system, thinking)))
  }
  const history = host === undefined ? fragments : fragments.slice(1)
  if (state.toolCount > 0) {
    regions.push({
      order: order++,
      seq: null,
      kind: 'tools',
      tokens: state.toolsTokens,
      // No provider count covers the envelope on its own: the difference it
      // could be read from spans a whole request, system prompt included.
      measured: false,
      // The row keeps the envelope's serialized text, as it did before.
      preview: state.toolsText.slice(0, ROW_LIMIT),
      // Nothing is cut from this region: the block exists once per request, and
      // it is the part of the prompt a reader most often wants in full. In the
      // prompt itself it is appended after a blank line, which is why the
      // fragment starts with one — and it carries the prompt's opening when no
      // system prompt survived to carry it.
      truncated: false,
      served: `${system === undefined ? head : ''}\n\n${state.toolsServed}`,
    })
  }
  servedEntries.forEach((entry, index) => {
    // Every region but the first starts with its own marker or with the blank
    // line that joins it to the previous message; the first region of a session
    // with neither a system prompt nor a tool block carries the prompt's opening.
    const opening = host === undefined && order === 0 ? MARKERS.BOS : ''
    regions.push(regionOf(entry, order++, `${opening}${history[index]}`, clippedOf(entry, thinking)))
  })
  // The total the panel draws and sums against: exactly the regions above, each
  // at the price a reader sees — the provider's count where one covers it, this
  // plugin's estimate otherwise.
  let totalTokens = state.toolsTokens
  for (const entry of state.entries) {
    if (!earnsRegion(entry)) continue
    totalTokens += pricedOf(entry)
  }
  return {
    failure: state.failure,
    contextWindow: state.contextWindow,
    totalTokens,
    reportPromptTokens: state.reportedPromptTokens,
    regions,
  }
}

/** A fresh empty state for one Session. */
function emptyState() {
  return {
    entries: [],
    toolsTokens: 0,
    toolCount: 0,
    toolsText: '',
    toolsServed: '',
    // The route's thinking settings decide how the prompt marks reasoning, so a
    // region cannot be rendered without them. `request/header` carries them.
    thinking: false,
    effort: '',
    contextWindow: null,
    // What the provider said the previous request cost, or 0 before it says
    // anything. Every other figure here is priced by this plugin.
    reportedPromptTokens: 0,
    reportedOutputTokens: 0,
    // The prompt size a later request is differenced against, or null while the
    // chain is broken (before the first report, and across a compaction, which
    // is not the previous image plus what this window appended).
    deltaBase: null,
    // Seqs of the messages appended since the last reported request. A window
    // holding exactly one of them is the case the difference can price.
    pending: [],
    asOf: -1,
    failure: null,
  }
}

/** Whether a value is a plain record. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is a non-negative safe integer. */
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0
}

/**
 * Validate a persisted state row before it seeds a fold. The registry calls
 * `stateSchema.parse` on every checkpoint row and requires a throw to discard a
 * row it cannot use, so a structurally wrong state must fail loud here rather
 * than let `apply` read undefined fields. A row from an older `stateVersion` is
 * already discarded by the registry before this runs.
 * @param value - the candidate state.
 * @returns the state, unchanged.
 * @throws when the value does not satisfy the state contract.
 */
function assertState(value) {
  if (!isRecord(value)) throw new Error('context explorer: persisted state is not an object')
  if (!Array.isArray(value.entries)) throw new Error('context explorer: persisted state has no entries array')
  for (const entry of value.entries) {
    if (!isRecord(entry)) throw new Error('context explorer: persisted entry is not an object')
    if (!isCount(entry.seq) || !isCount(entry.tokens)) {
      throw new Error('context explorer: persisted entry has a non-numeric count')
    }
    if (typeof entry.kind !== 'string' || typeof entry.preview !== 'string') {
      throw new Error('context explorer: persisted entry has a non-string kind')
    }
    if (typeof entry.reasoning !== 'string' || typeof entry.text !== 'string') {
      throw new Error('context explorer: persisted entry has no served text')
    }
    if (!Array.isArray(entry.calls)) {
      throw new Error('context explorer: persisted entry has no tool calls')
    }
    if (entry.reported !== null && !isCount(entry.reported)) {
      throw new Error('context explorer: persisted entry has an invalid measured price')
    }
    if (typeof entry.cutReasoning !== 'boolean' || typeof entry.cutText !== 'boolean' || typeof entry.cutCalls !== 'boolean') {
      throw new Error('context explorer: persisted entry has no clip flags')
    }
  }
  if (!isCount(value.toolsTokens) || !isCount(value.toolCount)) {
    throw new Error('context explorer: persisted state has a non-numeric tool count')
  }
  if (typeof value.toolsText !== 'string' || typeof value.toolsServed !== 'string') {
    throw new Error('context explorer: persisted state has no tool text')
  }
  if (typeof value.thinking !== 'boolean' || typeof value.effort !== 'string') {
    throw new Error('context explorer: persisted state has no thinking settings')
  }
  if (!isCount(value.reportedPromptTokens) || !isCount(value.reportedOutputTokens)) {
    throw new Error('context explorer: persisted state has no provider usage')
  }
  if (value.deltaBase !== null && !isCount(value.deltaBase)) {
    throw new Error('context explorer: persisted state has an invalid difference base')
  }
  if (!Array.isArray(value.pending) || value.pending.some(seq => !isCount(seq))) {
    throw new Error('context explorer: persisted state has no open window')
  }
  if (value.contextWindow !== null && !isCount(value.contextWindow)) {
    throw new Error('context explorer: persisted state has an invalid context window')
  }
  if (!Number.isSafeInteger(value.asOf)) {
    throw new Error('context explorer: persisted state has no watermark')
  }
  if (value.failure !== null && typeof value.failure !== 'string') {
    throw new Error('context explorer: persisted state has an invalid failure field')
  }
  return value
}

/**
 * Validate the view before it leaves the host. The view is built here, so this
 * guards the figures a wiring mistake could leave out of sync with the client.
 * @param value - the candidate view.
 * @returns the view, unchanged.
 * @throws when the view does not satisfy the wire contract.
 */
function assertView(value) {
  if (!isRecord(value)) throw new Error('context explorer: view is not an object')
  if (!Array.isArray(value.regions)) {
    throw new Error('context explorer: view has no regions')
  }
  if (!isCount(value.totalTokens) || !isCount(value.reportPromptTokens)) {
    throw new Error('context explorer: view has a non-numeric total')
  }
  if (value.contextWindow !== null && !isCount(value.contextWindow)) {
    throw new Error('context explorer: view has an invalid context window')
  }
  if (value.failure !== null && typeof value.failure !== 'string') {
    throw new Error('context explorer: view has an invalid failure field')
  }
  return value
}

/** The projection unit registered into `ctx.sessionProjections`. */
export const contextExplorerProjection = {
  key: 'contextExplorer',
  stateVersion: STATE_VERSION,
  stateSchema: { parse: assertState },
  init: emptyState,
  apply: (state, event) => foldEvent(state, event),
  wire: { viewSchema: { parse: assertView }, view: viewOf },
}

/**
 * Fold one committed event, containing any failure the way the shipped
 * projection units do.
 *
 * The registry drives every unit from one synchronous loop over committed
 * events, so a throw here would abort the drive for this unit's whole cell. A
 * shape this plugin did not anticipate is therefore recorded in the view and
 * the fold stops, rather than breaking the session's projection pass.
 * @param state - the folded state.
 * @param event - the next committed session event.
 * @returns the next state.
 */
function foldEvent(state, event) {
  if (state.failure !== null) return state
  try {
    return applyEvent(state, event)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ...state, failure: `context explorer replay failed at session event ${event.seq}: ${message}` }
  }
}

/**
 * The transition for one event.
 * @param state - the folded state.
 * @param event - the next committed session event.
 * @returns the next state, or the same reference when the event is unrelated.
 */
function applyEvent(state, event) {
  if (event.type === 'request/header') {
    const header = event.data.header
    const tools = Array.isArray(header.tools) ? header.tools : []
    // The row keeps the envelope's serialized text: it must read as the request
    // does, and it is the same string the estimator prices. The served block is
    // the prompt's own rendering of the same schemas.
    const text = tools.length === 0 ? '' : JSON.stringify(tools)
    // A route that turns thinking off drops the effort, and anything other than
    // `off` turns it on; this is the adapter's own rule.
    const config = header.config ?? {}
    const effort = typeof config.reasoningEffort === 'string' ? config.reasoningEffort : ''
    return {
      ...state,
      toolsTokens: estimateToolsTokens(tools),
      toolCount: tools.length,
      toolsText: text.slice(0, PREVIEW_LIMIT),
      toolsServed: tools.length === 0 ? '' : renderToolPrompt(tools),
      thinking: effort !== '' && effort !== 'off',
      effort,
      asOf: event.seq,
    }
  }
  if (event.type === 'request/context') {
    // Only the window is kept: it is the one route fact the panel draws against.
    const data = event.data
    return {
      ...state,
      contextWindow: data.contextWindow === undefined ? null : data.contextWindow,
      asOf: event.seq,
    }
  }
  if (!isSurfaceEvent(event)) {
    // A compaction rewrites the surface outside the append/replace protocol this
    // plugin folds, so the next request is not the previous image plus what this
    // window appended, and no difference may be attributed across it. The
    // provider's own totals are kept: they remain the last thing it reported.
    if (event.type.startsWith('compaction/')) {
      return { ...state, pending: [], deltaBase: null, asOf: event.seq }
    }
    return state
  }
  const entries = applySurface(state.entries, event)
  // A completed call reports what the request actually cost, counted by the
  // provider rather than by us. It is the one figure in this panel that is not
  // an estimate: `inputTokens` is the uncached part of the prompt, and the cache
  // reads and writes are the rest of it.
  const usage = event.type === 'assistant/message' && isRecord(event.data.usage) ? event.data.usage : undefined
  if (usage === undefined) {
    // The window is still open. Only an append can be priced by the difference
    // the next report will show; a replacement moves a range this state cannot
    // reconstruct, so the window is abandoned instead of guessed at.
    const open = event.surfaceOp === 'append' && event.type !== 'assistant/message'
    return {
      ...state,
      entries,
      pending: open ? [...state.pending, event.seq] : [],
      deltaBase: open ? state.deltaBase : null,
      asOf: event.seq,
    }
  }
  const prompt = reportedPromptTokens(usage)
  // Whether a node earns a region at all: the same test `viewOf` draws by, so a
  // node the panel skips can never carry a price into the total.
  const earns = (seq) => {
    const entry = entries.find(candidate => candidate.seq === seq)
    return entry !== undefined && earnsRegion(entry)
  }
  let priced = entries
  // A window holding exactly one message is priced by the difference: what the
  // request grew by, less the previous answer, is what that message cost to add.
  if (state.deltaBase !== null && state.pending.length === 1 && earns(state.pending[0])) {
    const measured = prompt - state.deltaBase - state.reportedOutputTokens
    if (measured > 0) priced = patchEntry(priced, state.pending[0], { reported: measured })
  }
  // The answer's own size is the count the provider reported for generating it.
  // A report without that field prices nothing: writing zero would claim the
  // provider measured an answer at nothing and drop the region's estimate mark.
  const hasOutput = isCount(usage.outputTokens)
  const output = hasOutput ? usage.outputTokens : 0
  if (hasOutput && earns(event.seq)) priced = patchEntry(priced, event.seq, { reported: output })
  return {
    ...state,
    entries: priced,
    reportedPromptTokens: prompt,
    reportedOutputTokens: output,
    // The next window's difference subtracts this answer's output, so a report
    // that does not state one leaves the chain broken rather than short by an
    // unknown amount.
    deltaBase: hasOutput ? prompt : null,
    pending: [],
    asOf: event.seq,
  }
}

/** The prompt size a provider's usage report describes, in its own counting. */
function reportedPromptTokens(usage) {
  let total = 0
  for (const field of ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    if (isCount(usage[field])) total += usage[field]
  }
  return total
}

/**
 * Services this plugin needs. `sessionProjections` is a hard dependency: the
 * whole plugin is one projection unit, so a profile without the registry should
 * leave the row pending rather than half-activate it.
 */
export const inject = ['sessionProjections']

/**
 * Host plugin body: own the projection unit for this fiber's lifetime.
 *
 * The registration is a direct call rather than a nested
 * `ctx.inject(['sessionProjections'], …)`. With the dependency already declared
 * above, a nested `ctx.inject` inside this body leaves its callback unrun — the
 * key then never appears in a snapshot, and a client reads the projection as
 * capability absence no matter what the session contains. The declared
 * dependency is what guarantees the service here, and `register` is itself an
 * effect on this fiber, so the unit still unloads with the plugin.
 * @param ctx - the plugin's own context, already carrying the declared service.
 */
export function apply(ctx) {
  ctx.sessionProjections.register(contextExplorerProjection)
}

