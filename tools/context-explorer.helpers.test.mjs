/**
 * Direct tests for the browser half's pure helpers.
 *
 * Small on purpose. Every decision below had a real defect behind it, and each is
 * a pure function of its arguments, so none of them needs a rendered tree:
 *
 * - `spansOf` + `coversRegion` decide which squares an open region owns. Building
 *   spans from a kind-filtered list instead of the whole list misaligned every
 *   span, so an open row outlined nothing or the wrong squares.
 * - `dominantRegion` decides which region a clicked square opens. It used to be a
 *   second copy of the same overlap scan inside the click handler, which no test
 *   could reach and which could disagree with the colour the square was painted.
 * - `visibleOpenRow` decides whether a row is open at all, keyed by the region's
 *   own identity rather than its position: a compaction inserts a region ahead of
 *   the selection, and a positional selection then expanded a row nobody picked.
 * - `gridPlanFor` decides the grid's scale. Measuring in CSS pixels instead of
 *   device pixels made the tracks fractional, which both beat as a moiré and, in
 *   one revision, collapsed the whole grid to a single row.
 * - `resolveCell` decides a square's colour and whether it reads as mixed.
 * - `groupByKind` produces the legend, and it once carried the tool envelope
 *   inside the user-message group because the host's accounting overlapped.
 * - `cellFill` is the one place a kind becomes a colour.
 *
 * The module is loaded the way the browser loads it, so this exercises the real
 * registration path rather than a copy of it.
 *
 * Run: node tools/context-explorer.helpers.test.mjs
 */

import { loadClientHelpers } from './check-shared.mjs'

let failures = 0
let checks = 0

/** Assert one condition. */
function check(label, condition, detail) {
  checks += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

const { visibleOpenRow, regionKey, coversRegion, resolveCell, dominantRegion, spansOf, groupByKind, cellFill, gridPlanFor } = loadClientHelpers()

/** One region with only the fields these helpers read. */
const region = (order, kind, tokens) => ({ order, kind, tokens })

console.log('spansOf and coversRegion — an open region owns its own squares')
{
  const regions = [region(0, 'system', 1000), region(1, 'tool', 5000), region(2, 'user', 1000), region(3, 'tool', 20000)]
  const spans = spansOf(regions)
  check('spans tile the window from zero to the total',
    spans.every((span, index) => span.from === (index === 0 ? 0 : spans[index - 1].to))
    && spans[spans.length - 1].to === regions.reduce((sum, entry) => sum + entry.tokens, 0),
    spans.map(span => `${span.from}-${span.to}`).join(' '))

  // The defect: a filtered list makes spans[order] resolve to the wrong region.
  // The probe sits inside region 3's span, which is what index 1 of the filtered
  // list actually holds: only a range the neighbour covers can tell the
  // misaligned list from the aligned one, since a range nobody covers reads
  // `false` either way.
  const filtered = spansOf(regions.filter(entry => entry.kind === 'tool'))
  check('an index into the wrong span list resolves to nothing, not to a neighbour',
    coversRegion(filtered, 1, 10000, 10001) === false)

  // The full list, probed at two different orders: one is the order the filtered
  // list got wrong, and a different one is what catches a lookup that ignores
  // the order and reads the first span of the list.
  check('the full span list resolves the order it was given',
    coversRegion(spans, 1, 1000, 1001) === true && coversRegion(spans, 3, 10000, 10001) === true)
  check('a square after a region is not covered', coversRegion(spans, 1, 6000, 6001) === false)
  check('a square straddling a boundary still counts as covered',
    coversRegion(spans, 0, 999, 1001) === true)
}

console.log('\ndominantRegion — a clicked square opens the region it was painted from')
{
  // The list repeats a kind on purpose: the answer has to be a row, not a kind,
  // so two tool results let a kind-ranking implementation pass a kind comparison
  // while still expanding the wrong row.
  const regions = [region(0, 'system', 1000), region(1, 'tool', 5000), region(2, 'user', 1000), region(3, 'tool', 20000)]
  const spans = spansOf(regions)

  const inside = [[100, 200, 0], [2000, 2100, 1], [6500, 6600, 2], [10000, 10100, 3]]
  const owners = inside.map(([from, to]) => dominantRegion(spans, from, to))
  check('a square wholly inside one region opens that exact region',
    owners.every((owner, index) => owner === regions[inside[index][2]]),
    owners.map(owner => (owner === null ? 'null' : owner.order)).join(','))

  // A straddling square is painted by the kind holding most of it, so a click on
  // it must land on a region of that same kind or the colour and the row it opens
  // disagree. Sampled over every cell-sized range in the window — including the
  // free space past the end, and three ranges split exactly evenly, where both
  // functions have to keep the earlier region rather than pick arbitrarily.
  const step = 100
  const total = spans[spans.length - 1].to
  const starts = []
  for (let from = 0; from <= total + step; from += step) starts.push(from)
  starts.push(950, 5950, 6950)
  const disagreements = []
  for (const from of starts) {
    const owner = dominantRegion(spans, from, from + step)
    const painted = resolveCell(spans, from, from + step)
    if (owner === null || painted.kind === null) {
      if (owner !== null || painted.kind !== null) {
        disagreements.push(`${from}: owner=${owner === null ? 'null' : owner.kind} painted=${painted.kind}`)
      }
      continue
    }
    if (owner.kind !== painted.kind) disagreements.push(`${from}: owner=${owner.kind} painted=${painted.kind}`)
  }
  check('the colour a square is painted and the kind it opens on agree everywhere',
    disagreements.length === 0, disagreements.slice(0, 5).join('; '))
}

console.log('\nvisibleOpenRow — the open row must be one the list still shows')
{
  // The selection is a region key, not an order: see the check at the end.
  const at = (order, kind, seq) => ({ order, kind, tokens: 1, seq })
  const view = { regions: [at(0, 'system', 1), at(1, 'tool', 2), at(2, 'user', 3)] }
  const picked = regionKey(view.regions[1])
  check('an existing region is open, with no filter or under its own',
    visibleOpenRow(view, picked, null) === 1 && visibleOpenRow(view, picked, 'tool') === 1)
  check('a filter that excludes it, or a view that no longer has it, closes it',
    visibleOpenRow(view, picked, 'user') === null && visibleOpenRow(view, 'user:99', null) === null)
  check('no view yet is not open', visibleOpenRow(undefined, picked, null) === null)
  check('order 0 is a real row, not a falsy miss', visibleOpenRow(view, regionKey(view.regions[0]), null) === 0)

  // The reason the selection is a key rather than a position: a compaction that
  // replaces a range with one node inserts a region ahead of everything after
  // it, so a positional selection would expand and outline its neighbour.
  const grown = { regions: [at(0, 'system', 1), at(1, 'developer', 9), at(2, 'tool', 2), at(3, 'user', 3)] }
  const resolved = visibleOpenRow(grown, picked, null)
  check('a selection made before a region was inserted ahead opens the same region',
    resolved === 2 && grown.regions[resolved].seq === view.regions[1].seq,
    `resolved order ${resolved} of ${grown.regions.map(entry => entry.seq).join(',')}`)
}

console.log('\nresolveCell — a square takes the kind holding most of it')
{
  const spans = spansOf([region(0, 'system', 1000), region(1, 'tool', 1000)])
  const whole = resolveCell(spans, 100, 200)
  check('a square inside one region takes that kind', whole.kind === 'system' && whole.second === null)

  const tail = resolveCell(spans, 900, 1100)
  check('a square straddling two regions takes the larger share and reads as mixed',
    tail.kind === 'system' && tail.second === 'tool', `kind=${tail.kind} second=${tail.second}`)

  const mostly = resolveCell(spans, 900, 1500)
  check('a minority under a third does not read as mixed', mostly.kind === 'tool' && mostly.second === null,
    `kind=${mostly.kind} second=${mostly.second}`)

  check('free space past the end has no kind', resolveCell(spans, 2500, 2600).kind === null)
  check('the fill is a token, a blend when mixed, and the fallback ink for an unknown kind',
    cellFill('tool', 'user') !== cellFill('tool', null)
    && cellFill('tool', null).startsWith('var(')
    && cellFill('no-such-kind', null) === cellFill('other', null))
}

console.log('\ngroupByKind — the legend partitions the window')
{
  const regions = [region(0, 'tool', 100), region(1, 'user', 50), region(2, 'tool', 25)]
  const groups = groupByKind(regions)
  const counts = groups.reduce((sum, group) => sum + group.count, 0)
  const tokens = groups.reduce((sum, group) => sum + group.tokens, 0)
  check('one entry per kind, counting every region and every token exactly once',
    groups.length === 2 && counts === regions.length && tokens === regions.reduce((sum, entry) => sum + entry.tokens, 0),
    `groups=${groups.length} counts=${counts} tokens=${tokens}`)
}

console.log('\ngridPlanFor — every edge lands on a whole device pixel')
{
  // The real panel: about 780 device pixels wide and 700 tall at 150% scaling.
  // `unit` is 1/1.5 CSS px, which is not exactly representable in binary, so
  // every comparison here works in device pixels — sub-picometre drift is not
  // what this function has to get right.
  const unit = 1 / 1.5
  const width = 780 * unit
  const height = 700 * unit
  const plan = gridPlanFor(width, height, unit)
  const toDevice = (cssPx) => Math.round(cssPx / unit)
  const wholeDevice = (cssPx) => Math.abs(cssPx / unit - Math.round(cssPx / unit)) < 1e-6
  // The step comes off the plan rather than a restated constant, so changing the
  // square size moves these checks with it instead of failing them.
  const sideDevice = toDevice(plan.sidePx)
  const gapDevice = toDevice(plan.gapPx)
  const spanDevice = (tracks) => tracks * sideDevice + (tracks - 1) * gapDevice

  check('a laid-out box produces a plan, and a box with no size yet produces nothing rather than a degenerate grid',
    plan !== null && gridPlanFor(0, 100, 1) === null && gridPlanFor(100, 0, 1) === null
    && gridPlanFor(100, 100, 0) === null)
  // A floor is only worth having if a degenerate box still hits it, which is
  // also the shape the grid collapsed to when the arithmetic was wrong.
  check('the grid keeps its row and column floors, even in a one-pixel box',
    plan.rows >= 2 && gridPlanFor(520, 1, unit).rows >= 2
    && plan.columns >= 4 && gridPlanFor(1, 400, unit).columns >= 4,
    `${plan.rows} rows (${gridPlanFor(520, 1, unit).rows} in a 1px band), ${plan.columns} columns (${gridPlanFor(1, 400, unit).columns} in a 1px strip)`)

  // The defect this function exists to prevent: fractional tracks make the
  // browser round each square's edges independently and the grid beats.
  check('the square and the gap are whole numbers of device pixels',
    wholeDevice(plan.sidePx) && wholeDevice(plan.gapPx), `${plan.sidePx / unit} / ${plan.gapPx / unit}`)

  // `width` and `height` are the element's own size, so its right and bottom
  // edges are whole too and match the span its tracks actually paint.
  check('the drawn size is the tracks\' own span, in whole device pixels',
    wholeDevice(Number.parseFloat(plan.width)) && toDevice(Number.parseFloat(plan.width)) === spanDevice(plan.columns)
    && wholeDevice(Number.parseFloat(plan.height)) && toDevice(Number.parseFloat(plan.height)) === spanDevice(plan.rows),
    `${toDevice(Number.parseFloat(plan.width))}x${toDevice(Number.parseFloat(plan.height))} vs ${spanDevice(plan.columns)}x${spanDevice(plan.rows)}`)

  const drawnWidth = toDevice(Number.parseFloat(plan.width)) * unit
  const drawnHeight = toDevice(Number.parseFloat(plan.height)) * unit
  check('the grid fits the box it was measured from and leaves less than one square of slack',
    drawnWidth <= width + 0.001 && drawnHeight <= height + 0.001
    && width - drawnWidth < plan.sidePx + plan.gapPx && height - drawnHeight < plan.sidePx + plan.gapPx,
    `${drawnWidth.toFixed(2)}x${drawnHeight.toFixed(2)} in ${width.toFixed(2)}x${height.toFixed(2)}`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
