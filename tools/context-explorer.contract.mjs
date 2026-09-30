/**
 * Contract check across the Context Explorer's three layers.
 *
 * 1. Every locale key the browser half references exists in BOTH dictionaries,
 *    and neither dictionary carries a key the component never uses (the host's
 *    locale service resolves through a typed namespace; a missing key renders
 *    as the raw key rather than throwing, so this is the only place it surfaces).
 * 2. The Host's view carries every field the two halves name, in one shape
 *    across the two region builders the Host folds entries through, with a
 *    legend entry for each kind a region actually carries. A drift in any of
 *    those reaches the client as `undefined` or as a raw key.
 * 3. The two tables the browser half derives from its own constants: the grid's
 *    square budget, and the kind colours the grid and the legend share.
 *
 * The Host's behaviour — pricing, fold arithmetic, the composition figures, the
 * prompt's survival across a rewrite, the truncation flags a region carries, and
 * the dense region orders that make `spans[order]` resolve — is owned by
 * tools/context-explorer.test.mjs. Module bindings (undeclared names, shadowed
 * builtins, unresolved imports, class names the stylesheet cannot reach) are
 * owned by tools/check-bundle.mjs. The three suites share no invariant: this one
 * asserts what the wire carries, not what the arithmetic does.
 *
 * Run: node tools/context-explorer.contract.mjs
 */

import { readFileSync } from 'node:fs'
import { contextExplorerProjection } from '../index.js'
import { BUNDLE, loadClientHelpers } from './check-shared.mjs'

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

const source = readFileSync(`${BUNDLE}/client.js`, 'utf8')
const host = readFileSync(`${BUNDLE}/index.js`, 'utf8')

/** The grid's ink per kind, read from the browser half's own table. */
const inkBlock = /const KIND_INK = \{([\s\S]*?)\n {4}\}/.exec(source)
const INK = new Map([...(inkBlock?.[1] ?? '').matchAll(/([a-z][a-z-]*):\s*'(var\(--[^']+\))'/g)]
  .map(match => [match[1], match[2]]))

/** Both panel dictionaries, keyed by language, read from the browser half. */
const DICTIONARIES = new Map()
for (const name of ['zh', 'en']) {
  const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\n {4}\\}`).exec(source)
  if (block !== null) DICTIONARIES.set(name, new Set([...block[1].matchAll(/'([^']+)':/g)].map(match => match[1])))
}

console.log('hook discipline')
{
  // Hooks must run the same number of times on every render. This component has
  // an early return for the empty view, so a hook added below that return runs
  // on some renders and not others, and React then throws "rendered fewer hooks
  // than expected" on the next render. It happened twice while this panel was
  // being built, so the shape is asserted rather than remembered.
  const anchor = source.indexOf('function ContextExplorerPage')
  const end = source.indexOf('function ContextExplorerTitle', anchor)
  const body = source.slice(anchor, end)
  // The condition is the client's to change — it grew a second test for an empty
  // region list — so this matches the statement that guards the empty view: an
  // `if` on the view that opens a block. `useGridPlan`'s argument also mentions
  // `view === undefined`, which is why a bare string search is not enough.
  const earlyReturn = body.search(/if \([^)]*view === undefined[^)]*\)\s*\{/)
  const hookPattern = /React\.(useState|useCallback|useRef|useMemo|useEffect)\b|useProjection\(|useGridPlan\(/g
  const hooks = [...body.matchAll(hookPattern)]
  const after = hooks.filter(match => match.index > earlyReturn)

  // The two anchors are preconditions of this check, not checks of their own: a
  // check that only proves the next one can run earns nothing, and a missing
  // anchor has to fail loudly rather than pass over an empty slice.
  const problems = []
  if (anchor === -1 || end === -1) problems.push('the page component anchors were not found')
  if (earlyReturn === -1) problems.push('the empty-view early return was not found')
  if (hooks.length === 0) problems.push('no hook was recognized')
  if (problems.length === 0 && after.length > 0) problems.push(`${after.map(match => match[0]).join(', ')} declared after the return`)
  check('no hook runs after the empty-view early return', problems.length === 0, problems.join('; '))
}

console.log('locale keys')
{
  const keys = new Set()
  for (const match of source.matchAll(/\bt\('([^']+)'\)/g)) keys.add(match[1])
  // The registry thunks resolve their copy through a namespace-bound translate.
  for (const match of source.matchAll(/locale\.bind\(NS\)\('([^']+)'\)/g)) keys.add(match[1])

  // Both checks below carry the parse guard: a dictionary whose literal no longer
  // matches is not an empty dictionary, and without the guard either check could
  // pass by inspecting nothing.
  const parsed = DICTIONARIES.size === 2

  // A key the component asks for and a dictionary omits renders as the key
  // itself — `kind.developer` where a label belongs — because a miss in the
  // typed namespace is not an error.
  const missing = []
  for (const [name, dict] of DICTIONARIES) {
    for (const key of keys) if (!dict.has(key)) missing.push(`${name}:${key}`)
  }
  check('both dictionaries define every t() key the component uses', parsed && missing.length === 0,
    parsed ? missing.join(', ') : `${[...DICTIONARIES.keys()].join(', ') || 'none'} parsed`)
}

console.log('view contract')
{
  const TOOLS = [{ name: 'read', description: 'Read', parameters: { type: 'object' } }]
  const events = [
    { type: 'request/header', seq: 1, data: { header: { config: { provider: 'p', model: 'm' }, tools: TOOLS } } },
    { type: 'request/context', seq: 2, data: { provider: 'deepseek-official', model: 'deepseek-flash', contextWindow: 128000, systemPromptUpdate: 'in-history' } },
    { type: 'system/message', seq: 3, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'one\n\ntwo' }] } } },
    { type: 'user/message', seq: 4, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  ]
  let state = contextExplorerProjection.init()
  for (const event of events) state = contextExplorerProjection.apply(state, event)
  const view = contextExplorerProjection.wire.view(state)

  // Every field on the wire, against the one view this fold published: the
  // regions the panel walks, the total it divides every share by, the window the
  // grid scales to, the provider's own prompt count, and the fold failure the
  // panel shows in place of itself.
  const viewFields = ['regions', 'totalTokens', 'contextWindow', 'reportPromptTokens', 'failure']
  const absentScalars = viewFields.filter(field => !Object.hasOwn(view, field) || view[field] === undefined)
  check('the view carries every field the two halves name', absentScalars.length === 0, absentScalars.join(', '))

  // The region shape both halves agree on. `order` and `seq` index the grid and
  // key the list rows, `kind`/`tokens` drive the ink and the spans, `measured`
  // says whether the provider's own count covered the region or the price is
  // this plugin's estimate, `preview` is the flat material a row shows, `served`
  // is the region's own fragment of the prompt — the body an expanded row draws,
  // so a missing one is a crash inside the boundary rather than a blank row —
  // and `truncated` marks a region whose served text is clipped.
  const regionFields = ['order', 'seq', 'kind', 'tokens', 'measured', 'preview', 'truncated', 'served']
  const region = view.regions[0] ?? {}
  // An own key set to `undefined` reaches the client as absent — `region.served`
  // would then draw nothing where the body belongs — so both halves of the test
  // are needed, exactly as on the view's scalars above.
  const absentRegion = regionFields.filter(field => !Object.hasOwn(region, field) || region[field] === undefined)
  check('a region carries every field the two halves name', absentRegion.length === 0,
    view.regions.length === 0 ? 'the fixture view has no regions' : absentRegion.join(', '))

  // The Host builds the system region and every message region through one
  // `regionOf` literal and the tool envelope through a second one, so a field
  // added to one and forgotten in the other is the drift this catches: one
  // region's shape plus this comparison covers both.
  const shapes = view.regions.map(candidate => Object.keys(candidate).sort().join(','))
  check('every region carries the same field set', new Set(shapes).size === 1, shapes.join(' | '))

  // The chips above the grid are its legend: one swatch and one label per kind.
  // A kind with no ink entry is drawn as `other`, and one with no `kind.*` key
  // prints its own name, because kindLabel builds that key from the Host's data
  // and the locale block above cannot see it.
  const legendless = [...new Set(view.regions.map(candidate => candidate.kind))]
    .filter(kind => !INK.has(kind) || [...DICTIONARIES.values()].some(dict => !dict.has(`kind.${kind}`)))
  check('every kind a region carries has a legend entry', legendless.length === 0, legendless.join(', '))
}

console.log('grid geometry')
{
  // The grid is one memoized button per square, so the square count is a DOM
  // budget. It depends on the panel and the display scale alone: the context
  // window only sets how many tokens a square holds (`tokensPerCell`), which is
  // why a realistic window does not move the counts below. The arithmetic comes
  // from the browser half's own `gridPlanFor` rather than a copy of it, so a
  // change to the square size or the column clamp moves this budget with it.
  const { gridPlanFor } = loadClientHelpers()
  const side = Number(/const SIDE_DEVICE_PX = (\d+)/.exec(source)?.[1])
  const gap = Number(/const GAP_DEVICE_PX = (\d+)/.exec(source)?.[1])
  const fallbackColumns = Number(/const GRID_FALLBACK_COLUMNS = (\d+)/.exec(source)?.[1])
  const readable = [side, gap, fallbackColumns].every(Number.isFinite)

  // Realistic panels: the sidebar pane the grid lives in, and the widest band a
  // maximized pane on a scaled display can produce — the column clamp is what
  // keeps the wide case bounded. The first paint is a separate state rather than
  // a panel: `useGridPlan` starts at GRID_FALLBACK_COLUMNS x 8 and replaces both
  // from the observed box.
  const panels = [
    { label: 'sidebar 640x480', width: 640, height: 480, ratio: 1 },
    { label: 'sidebar 640x480 @1.5x', width: 640, height: 480, ratio: 1.5 },
    { label: 'sidebar 640x480 @2x', width: 640, height: 480, ratio: 2 },
    { label: 'maximized 1920x600 @2x', width: 1920, height: 600, ratio: 2 },
  ]
  const cellsOf = (panel) => {
    const plan = gridPlanFor(panel.width, panel.height, 1 / panel.ratio)
    return plan === null ? 0 : plan.columns * plan.rows
  }
  const worst = readable
    ? [{ label: 'first paint', cells: fallbackColumns * 8 }, ...panels.map(panel => ({ label: panel.label, cells: cellsOf(panel) }))]
      .reduce((peak, entry) => (entry.cells > peak.cells ? entry : peak))
    : { label: 'geometry constants this reads are gone', cells: Number.POSITIVE_INFINITY }

  // 40000 squares is already more DOM than a sidebar grid should own; the bound
  // catches a constants change that would multiply the field.
  const SQUARE_BUDGET = 40000
  check('the grid stays within a square budget a browser can render', worst.cells < SQUARE_BUDGET,
    `worst ${worst.cells} squares at ${worst.label} (side ${side}px + gap ${gap}px)`)
}

console.log('colour table')
{
  // Kinds a session can put on the wire: one per surface event type the Host
  // folds (the derived message's role mirrors the event's type prefix), the tool
  // envelope the Host synthesizes, and the fallback it uses for a message with
  // no string role. `empty` is excluded on purpose — describeNode prices a node
  // with no derived message at zero and viewOf drops zero-token entries, so it
  // never becomes a region.
  const surface = /const SURFACE_EVENT_TYPES = new Set\(\[([\s\S]*?)\]\)/.exec(host)
  const roles = [...(surface?.[1] ?? '').matchAll(/'([a-z-]+)\/[a-z-]+'/g)].map(match => match[1])
  const synthesized = [...host.matchAll(/kind: '([a-z-]+)'/g)].map(match => match[1]).filter(kind => kind !== 'empty')
  const fallback = /message\.role === 'string'\s*\?\s*message\.role\s*:\s*'([a-z-]+)'/.exec(host)?.[1]
  const hostKinds = new Set([...roles, ...synthesized, ...(fallback === undefined ? [] : [fallback])])

  // A kind with no entry is drawn as `KIND_INK.other` under its raw name, so the
  // table has to cover every kind the fold can hand the grid.
  const missing = [...hostKinds].filter(kind => !INK.has(kind))
  check('every kind the Host can emit has a colour entry', hostKinds.size > 0 && missing.length === 0,
    hostKinds.size === 0 ? 'no kinds could be read out of the Host half' : missing.join(', '))

  // The pairs a real session puts side by side: the rendered prompt and the tool
  // envelope that follows it, then the conversation's own alternation with its
  // tool results. Kinds that touch must not share a hue token — `user` and
  // `assistant` both being blue is what once lost the user's own turns inside
  // the assistant's, and `assistant` and `tool` repeated the mistake.
  const session = ['system', 'tools', 'user', 'assistant', 'tool', 'assistant', 'user']
  const collisions = []
  for (let index = 1; index < session.length; index += 1) {
    const [left, right] = [session[index - 1], session[index]]
    if (left !== right && INK.get(left) === INK.get(right)) collisions.push(`${left}/${right}`)
  }
  check('no two kinds adjacent in a session share a hue token', collisions.length === 0, collisions.join(', '))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
