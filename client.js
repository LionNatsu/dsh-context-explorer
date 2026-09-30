/**
 * Context Explorer (browser half).
 *
 * Draws the context one Session submits to its model as the whole context
 * window in fixed token squares: occupied space, free space, and the seams
 * where one kind of content meets another.
 *
 * Layout contract: the grid and the list split the panel, because they are the
 * two halves of one job. The grid is the way in — how full this is, and whether
 * anything is disproportionate, which no list shows at a glance. The list is
 * where a region is read and judged, in the same order the grid draws: picking a
 * square opens the region that owns most of it, and an open region is outlined
 * on the grid.
 *
 * Every figure comes from the Host `contextExplorer` session projection; this
 * half folds no session events and prices no content, so the numbers it shows
 * are the ones the Host derived with the same estimator its meter uses.
 *
 * @module dsh-context-explorer/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-explorer',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** The tab type's identity, and the key its body registers under. */
    const TAB_ID = 'dsh-context-explorer'
    const TAB_KIND = 'context-explorer'
    const NS = 'contextExplorer'

    /**
     * Theme tokens per region kind, with the resolved dark-theme values noted
     * because the names do not reveal them and the palette has no purple.
     *
     * Two rules decide the set:
     *
     * - Kinds that meet most often must not share a hue. `user` and `assistant`
     *   alternate through a conversation, so an earlier set that made both blue
     *   lost the user's own turns inside the assistant's; the same applied to
     *   `assistant` and `tool`.
     * - Where a hue does repeat, the two entries must differ in lightness as
     *   well, so they stay apart in greyscale too. The largest kinds are also
     *   the ones packed against each other, so they get the widest spread.
     *
     * Hues come from the static palette rather than the `--dsw-alias-*` roles:
     * in the dark theme `--dsw-alias-brand-primary` is near-white (#ebeef2) and
     * `--dsw-alias-state-idle-primary` a mid grey, so role tokens collapse into
     * one flat band. No literal colour is used.
     */
    const KIND_INK = {
      // #22c55e — the opener, always adjacent to the tool block
      system: 'var(--dsw-static-green-500)',
      // #f59e0b — one solid band after the opener
      tools: 'var(--dsw-static-amber-500)',
      // #f25a5a — small and scattered, so it can afford the loudest hue
      user: 'var(--dsw-static-red-400)',
      // #93c5fd, L 78% — the assistant's own output
      assistant: 'var(--dsw-static-blue-300)',
      // #4868b2, L 49% — the bulk of the window, and the counterweight above
      tool: 'var(--dsw-static-deepseek-600)',
      // #81858c, L 52% — near-absent in practice
      developer: 'var(--dsw-static-neutral-bluish-600)',
      // #61666b — the fallback
      other: 'var(--dsw-static-neutral-bluish-700)',
    }

    /** Free space: deliberately the surface colour, so gaps read as absence. */
    const FREE_INK = 'var(--dsw-alias-bg-layer-2)'

    /**
     * One device pixel, in CSS pixels.
     *
     * Every dimension of the grid is snapped to a whole number of device pixels.
     * Fractional geometry is what produced uneven squares: a fixed 5 CSS px
     * target yielded a 9.0128 px track, and the browser then rounded each cell's
     * edges on its own, so widths alternated between 9 and 10 device pixels in a
     * repeating pattern that read as a moiré across the whole grid. A 1px gap
     * was worse still, since at 150% scaling it is 1.5 device pixels and rounds
     * in whichever direction its position dictates.
     * @returns the CSS length of one device pixel.
     */
    function devicePx() {
      const ratio = typeof window === 'undefined' ? 1 : window.devicePixelRatio
      return Number.isFinite(ratio) && ratio > 0 ? 1 / ratio : 1
    }

    /**
     * Square edge and gap, in whole device pixels.
     *
     * Counted in device pixels rather than CSS pixels because that is the unit
     * the browser paints on, and it is the unit that must stay whole: a fixed CSS
     * size divides the panel into fractional tracks, which is what produced
     * uneven squares. Note the display scale when reading these — at 150% a
     * side of 7 is about 4.7 CSS px, so the same grid is finer on a scaled
     * display than on an unscaled one at the same panel width.
     */
    const SIDE_DEVICE_PX = 7
    const GAP_DEVICE_PX = 1

    /** Columns for the first paint, before the panel has been measured. */
    const GRID_FALLBACK_COLUMNS = 84

    /**
     * Characters of one region's text handed to the browser's own tooltip.
     *
     * A row already ellipsizes its text, and the tooltip exists to recover the
     * part the ellipsis hid. Browsers truncate long tooltips anyway, so this
     * bounds what the element carries rather than what the reader can see.
     */
    const HOVER_LIMIT = 400

    /**
     * Share of a square a second kind must hold before the square is drawn as a
     * two-colour diagonal.
     *
     * A square is about 4.7 CSS px on a 150%-scaled display, so the hatch is at
     * the edge of what the eye resolves and a field with many of them reads as
     * texture rather than as information. Raising the floor from 0.25 to 0.35 more
     * than halved the blended share on the log it was chosen from (20.6% to 8.6%),
     * which still marks a boundary without most of the noise. That share is a
     * property of the log, so read the pair as the measurement behind this floor
     * rather than as a constant.
     */
    const MIX_FLOOR = 0.35

    const zh = {
      'tab.title': '上下文',
      'empty.title': '尚无上下文数据',
      'empty.body': '插件还没有为这个会话发布上下文。',
      'guide.description': '查看提交给模型的上下文构成',
      'grid.free': '空闲空间',
      'grid.perCell': '每格 {tokens} tokens',
      'grid.summary': '已用 {used} / {total}',
      'grid.summaryNote': '服务端上报的上一次请求 prompt token 数;还没有请求报过数时显示面板自己的合计。',
      'kind.system': '系统提示词',
      'kind.tools': '工具定义',
      'kind.user': '用户消息',
      'kind.assistant': '助手消息',
      'kind.tool': '工具结果',
      'kind.developer': '开发者消息',
      'kind.other': '其他',
      'detail.noText': '无文本',
      'detail.clipped': '已截断',
      'detail.clippedNote': '（此条目只保留了开头部分，以上不是全部）',
      'item.approx': '≈{tokens}',
      'list.bySize': '按大小',
      'list.byOrder': '按顺序',
    }

    const en = {
      'tab.title': 'Context',
      'empty.title': 'No context data yet',
      'empty.body': 'The plugin has not published context for this Session yet.',
      'guide.description': 'See how the context submitted to the model is composed',
      'grid.free': 'free space',
      'grid.perCell': '{tokens} tokens per square',
      'grid.summary': 'used {used} / {total}',
      'grid.summaryNote': 'the prompt size the provider reported for the last request; until one reports, this panel\'s own total.',
      'kind.system': 'System prompt',
      'kind.tools': 'Tool schemas',
      'kind.user': 'User message',
      'kind.assistant': 'Assistant message',
      'kind.tool': 'Tool result',
      'kind.developer': 'Developer message',
      'kind.other': 'Other',
      'detail.noText': 'No text',
      'detail.clipped': 'clipped',
      'detail.clippedNote': '(only the beginning is retained; this is not all of it)',
      'item.approx': '≈{tokens}',
      'list.bySize': 'by size',
      'list.byOrder': 'in order',
    }

    /** Locale keys this plugin owns. Text is data, not logic. */
    const KEYS = new Set(Object.keys(zh))

    /**
     * The panel's stylesheet.
     *
     * The grid element's own geometry and the error boundary's box stay inline:
     * the grid's tracks are measured numbers, and the boundary renders *instead*
     * of the page that mounts this block, so a class rule would not be there when
     * it needs one. Everything else is here, because inline styles are for
     * component-local computed values, not for presentation.
     *
     * The `min-width: 0` entries are load-bearing. A flex item defaults to
     * `min-width: auto`, so a long child sets its row's floor and that row's
     * container grows past the panel — which is how an expanded region came to
     * draw over the conversation beside the sidebar.
     *
     * The two floors are the reason the band and the list cannot starve each
     * other on a short panel: the grid keeps 96px so a shape is still readable,
     * and the list keeps 120px so a square's answer still fits a row.
     *
     * Radii follow the DSH corner-radius scale by role: the chips and the clip
     * badge are small details (`--dsw-radius-xs`), a list row is a compact
     * control (`--dsw-radius-sm`), and the expanded body keeps the row's step so
     * the open row stays one contour. The grid squares and the colour swatch are
     * drawing details and keep their own tiny radius.
     */
    const css = `
      .ctxex { display: flex; flex-direction: column; gap: 10px; overflow: hidden; font: var(--dsw-font-xxxs-11); }
      .ctxex .sub { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
      .ctxex .row { display: flex; align-items: center; gap: 8px; }
      .ctxex .chipRow { flex-wrap: wrap; row-gap: 4px; }
      .ctxex .listToggle { margin-left: auto; }
      .ctxex .chip { display: flex; align-items: center; gap: 4px; padding: 0; border: 1px solid transparent; border-radius: var(--dsw-radius-xs); background: none; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }
      .ctxex .chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .ctxex .chip[data-on="true"] { border-color: var(--dsw-alias-brand-primary); }
      .ctxex .chip b { font-weight: 600; font-variant-numeric: tabular-nums; }
      .ctxex .swatch { flex: none; width: 8px; height: 8px; border-radius: 2px; }
      .ctxex .gridBand { flex: 0 0 25%; min-height: 96px; display: flex; }
      .ctxex .gridBox { width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; }
      .ctxex .grid { display: grid; }
      .ctxex .cell { padding: 0; border: none; border-radius: 1px; cursor: pointer; }
      .ctxex .list { flex: 1 1 auto; min-width: 0; min-height: 120px; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 1px; }
      .ctxex .item { display: flex; align-items: baseline; gap: 7px; box-sizing: border-box; width: 100%; padding: 4px 6px; border: 1px solid transparent; border-radius: var(--dsw-radius-sm); background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .ctxex .itemWrap { border-radius: var(--dsw-radius-sm); min-width: 0; }
      .ctxex .itemWrap[data-open="true"] { background: var(--dsw-alias-bg-layer-1); }
      .ctxex .itemBody { box-sizing: border-box; max-width: 100%; margin: 0 0 6px; padding: 8px; max-height: 300px; overflow: auto; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-layer-2); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: var(--dsh-content-font-size-secondary, 13px); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; color: var(--dsw-alias-label-primary); }
      .ctxex .itemMark { flex: none; padding: 0 4px; border-radius: var(--dsw-radius-xs); color: var(--dsw-alias-label-secondary); border: 0.5px solid var(--dsw-alias-border-l2); }
      .ctxex .item:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .ctxex .item[data-on="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-1); }
      .ctxex .itemSrc { flex: 1 1 auto; min-width: 0; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ctxex .itemNum { flex: none; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .ctxex .empty { display: flex; flex-direction: column; gap: 4px; color: var(--dsw-alias-label-secondary); }
      .ctxex .error { color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; word-break: break-word; }
    `

    /** Localized label for one region kind. */
    function kindLabel(t, kind) {
      const key = `kind.${kind}`
      return KEYS.has(key) ? t(key) : kind
    }

    /**
     * Human-scale token count: exact below ten thousand, then one decimal of
     * thousands. `Math.round` rather than `toFixed`, so a whole count never
     * reads as "325.0k" while a fractional one still does.
     */
    function formatTokens(value) {
      if (!Number.isFinite(value)) return '—'
      const thousands = value / 1000
      return value < 10000 ? String(value) : `${Math.round(thousands * 10) / 10}k`
    }

    /** Fill one placeholder in a locale string. */
    function fill(template, values) {
      let text = template
      for (const [key, value] of Object.entries(values)) text = text.replace(`{${key}}`, String(value))
      return text
    }

    /**
     * Group regions by kind, heaviest first.
     *
     * The kind is the only classification the Host asserts, so it is the one
     * grouping that can be offered without inventing categories.
     * @param regions - the Host's regions in model-visible order.
     * @returns one entry per kind with its count and token total.
     */
    function groupByKind(regions) {
      const groups = new Map()
      for (const region of regions) {
        const group = groups.get(region.kind) ?? { kind: region.kind, count: 0, tokens: 0 }
        group.count += 1
        group.tokens += region.tokens
        groups.set(region.kind, group)
      }
      return [...groups.values()].sort((left, right) => right.tokens - left.tokens)
    }

    /** Token span every region occupies, in model-visible order. */
    function spansOf(regions) {
      const spans = []
      let cursor = 0
      for (const region of regions) {
        const from = cursor
        cursor += region.tokens
        spans.push({ region, from, to: cursor })
      }
      return spans
    }

    /**
     * Every span meeting a token range, with the tokens it holds inside it.
     *
     * One walk serves both questions the grid asks of a square — which kind
     * fills it, and which region owns it — so the two answers can never be
     * computed from different overlaps. The spans are ordered and disjoint, so
     * the walk stops at the first span past the range.
     * @param spans - the token spans in order.
     * @param from - the range's first token.
     * @param to - one past the range's last token.
     * @returns one `{span, overlap}` per span meeting the range, in order.
     */
    function overlapsOf(spans, from, to) {
      const overlaps = []
      for (const span of spans) {
        if (span.to <= from) continue
        if (span.from >= to) break
        const overlap = Math.min(span.to, to) - Math.max(span.from, from)
        if (overlap > 0) overlaps.push({ span, overlap })
      }
      return overlaps
    }

    /**
     * The region holding most of one token range: the region a click on that
     * square opens.
     * @param spans - the token spans in order.
     * @param from - the range's first token.
     * @param to - one past the range's last token.
     * @returns the region, or null when the range holds no region at all.
     */
    function dominantRegion(spans, from, to) {
      let best = null
      for (const { span, overlap } of overlapsOf(spans, from, to)) {
        if (best === null || overlap > best.overlap) best = { region: span.region, overlap }
      }
      return best === null ? null : best.region
    }

    /**
     * One square of the grid: the kind holding most of its token range, and the
     * runner-up when that kind is a real minority rather than noise.
     * @param spans - the token spans in order.
     * @param from - the square's first token.
     * @param to - one past the square's last token.
     * @returns the kind, and the second kind or null when the square is mixed.
     */
    function resolveCell(spans, from, to) {
      const held = new Map()
      for (const { span, overlap } of overlapsOf(spans, from, to)) {
        held.set(span.region.kind, (held.get(span.region.kind) ?? 0) + overlap)
      }
      if (held.size === 0) return { kind: null, second: null }
      // A tie keeps the kind that comes first in the surface order, because the
      // sort is stable over the insertion order above.
      const ranked = [...held].sort((left, right) => right[1] - left[1])
      const second = ranked[1] !== undefined && ranked[1][1] / (to - from) >= MIX_FLOOR ? ranked[1][0] : null
      return { kind: ranked[0][0], second }
    }

    /** Solid ink for one kind, or a diagonal blend when a square is genuinely mixed. */
    function cellFill(kind, second) {
      const first = KIND_INK[kind] ?? KIND_INK.other
      if (second === null) return first
      const other = KIND_INK[second] ?? KIND_INK.other
      // The stripe period is counted in device pixels like every other dimension
      // here, so the blend lands on the same grid the squares are snapped to.
      const unit = devicePx()
      return `repeating-linear-gradient(45deg, ${first} 0 ${unit}px, ${other} ${unit}px ${unit * 2}px)`
    }

    /**
     * The identity of one region, stable while the session grows.
     *
     * `region.order` is a position, and positions move: a compaction replaces a
     * whole range with a single node, and an in-history prompt append inserts one
     * ahead of everything after it. A selection held as an order would then
     * expand and outline a region the user never picked. The sequence a region
     * was derived from survives all of that, and the tool envelope — the one
     * region with no sequence — is unique by kind.
     * @param region - one region of the view.
     * @returns a string identifying that region across publishes.
     */
    function regionKey(region) {
      return region.seq === null ? 'tools' : `${region.kind}:${region.seq}`
    }

    /**
     * Which row is open, or null when nothing is.
     *
     * Narrowed by both ways a row can be hidden, so a stale selection can never
     * outline or expand a row that is not on screen — the ring and the expansion
     * are the only things tying the grid to the list, so a disagreement between
     * them is exactly what makes a click look dead:
     *
     * - the region must still be in the view, since a later event can drop it;
     * - it must survive the active kind filter, or the grid would keep outlining
     *   a region the list no longer shows.
     *
     * Selecting a square clears the filter in the same update, so that path
     * still resolves to the region it picked.
     *
     * @param view - the projection value, or undefined before the first publish.
     * @param pickedKey - the identity of the region the user opened, or null.
     * @param pickedKind - the active kind filter, or null.
     * @returns the open region's current order, or null.
     */
    function visibleOpenRow(view, pickedKey, pickedKind) {
      if (view === undefined || pickedKey === null) return null
      const region = view.regions.find(candidate => regionKey(candidate) === pickedKey)
      if (region === undefined) return null
      if (pickedKind !== null && region.kind !== pickedKind) return null
      return region.order
    }

    /**
     * Whether a square falls inside the token span an open region occupies.
     * @param spans - the token spans in order.
     * @param order - the region's position in that order.
     * @param from - the square's first token.
     * @param to - one past the square's last token.
     * @returns whether the square shows any of the region.
     */
    function coversRegion(spans, order, from, to) {
      if (order === null) return false
      const span = spans[order]
      if (span === undefined || span.region.order !== order) return false
      return span.from < to && span.to > from
    }

    /**
     * The highlight marking the open region's squares.
     *
     * Drawn with an inset shadow rather than `outline`: an inline outline
     * shorthand overrides the theme's own focus ring, and a square that is both
     * selected and focused would then show no keyboard focus at all.
     */
    const RING_STYLE = { boxShadow: 'inset 0 0 0 1px var(--dsw-alias-label-primary)' }

    /**
     * One square.
     *
     * Memoized: the grid is a few thousand leaves and picking a row or a square
     * must not rebuild them. The click handler arrives through `pickRef` rather
     * than as a prop, because a fresh function identity on every parent render
     * would defeat the memo entirely.
     *
     * Squares stay out of the tab order: there are thousands of them, and the row
     * list is the path a keyboard reader takes to the same selection.
     */
    const Cell = React.memo(function Cell({ order, kind, second, title, ring, pickRef }) {
      const fill = kind === null ? FREE_INK : cellFill(kind, second)
      return h('button', {
        type: 'button',
        className: 'cell',
        tabIndex: -1,
        'data-ctxex-cell': order,
        'data-kind': kind ?? 'free',
        'data-ring': ring ? 'true' : 'false',
        title,
        style: ring ? { background: fill, ...RING_STYLE } : { background: fill },
        onClick: () => { pickRef.current(order) },
      })
    })

    /**
     * The grid's track template and the size the element paints itself at, from
     * one cell count and one step in whole device pixels.
     *
     * The measured plan and the first paint's fallback both come through here,
     * because two copies of this arithmetic is how the cells stopped landing on
     * whole device pixels. Fixed tracks, not `1fr`: a flexible track divides the
     * leftovers and hands the cells a fractional width again.
     * @param plan - the column count, row count, square size and gap size.
     * @returns the CSS track template, width and height.
     */
    function tracksOf({ columns, rows, sidePx, gapPx }) {
      return {
        template: `repeat(${columns}, ${sidePx}px)`,
        // The box rarely equals whole tracks exactly and the slack has to go
        // somewhere. Left-aligning the tracks keeps both edges on whole device
        // pixels; stretching would put the remainder back into the geometry this
        // exists to keep integral.
        width: `${columns * sidePx + (columns - 1) * gapPx}px`,
        height: `${rows * sidePx + (rows - 1) * gapPx}px`,
      }
    }

    /**
     * The scale of the grid, in whole device pixels.
     *
     * Columns and rows are chosen so a square lands on an exact device-pixel edge
     * and the gap is an exact number of device pixels: the browser then paints
     * every square identically and the grid has no beat pattern. Rows are a fixed
     * height rather than `1fr` for the same reason.
     *
     * A pure function of the measured box, so it can be tested without a browser:
     * its arithmetic has been wrong once, when columns were derived in CSS pixels
     * and the grid collapsed to a single row.
     *
     * @param width - the box's width in CSS pixels.
     * @param height - the box's height in CSS pixels.
     * @param unit - the CSS length of one device pixel.
     * @returns the plan, or null when the box has not been laid out yet.
     */
    function gridPlanFor(width, height, unit) {
      if (!(width > 0) || !(height > 0) || !(unit > 0)) return null
      const pitch = SIDE_DEVICE_PX + GAP_DEVICE_PX
      // Columns from the width, then rows from what the height has left, so the
      // grid fills the panel down to the last whole square.
      const columns = Math.max(4, Math.min(200, Math.floor(width / (pitch * unit))))
      const rows = Math.max(2, Math.floor((height + GAP_DEVICE_PX * unit) / (pitch * unit)))
      const sidePx = SIDE_DEVICE_PX * unit
      const gapPx = GAP_DEVICE_PX * unit
      return { columns, rows, sidePx, gapPx, ...tracksOf({ columns, rows, sidePx, gapPx }) }
    }

    /**
     * The grid's scale, measured from the live element.
     *
     * The band is observed rather than the grid: the grid's own size is derived
     * from this measurement, so observing it makes the two feed back into each
     * other and the grid collapses toward nothing.
     * @returns `{ref, ...gridPlanFor}` with `cells: null` when no window is known.
     */
    function useGridPlan(window) {
      // The first paint happens before anything has been measured, so it uses a
      // plausible shape at a plausible square size; the first measure replaces it.
      const [plan, setPlan] = React.useState({
        columns: GRID_FALLBACK_COLUMNS, rows: 8, sidePx: 4, gapPx: 1,
      })
      const ref = React.useCallback((node) => {
        if (node === null) return
        const measure = () => {
          const measured = gridPlanFor(node.clientWidth, node.clientHeight, devicePx())
          if (measured === null) return
          // Only the geometry is state; the tracks are derived from it below.
          const next = {
            columns: measured.columns, rows: measured.rows, sidePx: measured.sidePx, gapPx: measured.gapPx,
          }
          setPlan(current => (
            current.columns === next.columns && current.rows === next.rows
              && current.sidePx === next.sidePx && current.gapPx === next.gapPx
              ? current
              : next
          ))
        }
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => { observer.disconnect() }
      }, [])
      const known = window !== null && window > 0
      const cells = known ? plan.columns * plan.rows : null
      return {
        ref,
        columns: plan.columns,
        rows: plan.rows,
        cells,
        sidePx: plan.sidePx,
        gapPx: plan.gapPx,
        tokensPerCell: cells === null ? 0 : window / cells,
        ...tracksOf(plan),
      }
    }

    /**
     * The grid: the whole context window in token squares, free space included.
     *
     * `ring` is the token span of the region whose row is open, so the squares
     * that region occupies are outlined. That is the link the panel was missing:
     * the list said which region, the grid says where it is.
     */
    function SpaceGrid({ spans, total, geometry, ring, onPick, t }) {
      const pickRef = React.useRef(onPick)
      pickRef.current = onPick
      const items = []
      if (geometry.cells !== null) {
        for (let index = 0; index < geometry.cells; index += 1) {
          const from = index * geometry.tokensPerCell
          const to = from + geometry.tokensPerCell
          const marked = coversRegion(spans, ring, from, to)
          if (from >= total) {
            items.push({ order: index, kind: null, second: null, ring: marked })
            continue
          }
          const resolved = resolveCell(spans, from, Math.min(to, total))
          items.push({ order: index, kind: resolved.kind, second: resolved.second, ring: marked })
        }
      }
      return h('div', {
        // The measured element is the band, never the grid: the grid's own size
        // is derived from the measurement, so observing it makes the two feed
        // back into each other and the grid collapses toward nothing.
        ref: geometry.ref,
        className: 'gridBox',
      },
      h('div', {
        className: 'grid',
        // Inline, not from the stylesheet: a fractional `1fr` row or a 1px gap
        // here is exactly what put the cells off the device-pixel grid. Fixed
        // tracks and whole-device-pixel dimensions leave the browser nothing to
        // round, so every square paints the same size.
        style: {
          gridTemplateColumns: geometry.template,
          gridAutoRows: `${geometry.sidePx}px`,
          gap: `${geometry.gapPx}px`,
          width: geometry.width,
          height: geometry.height,
        },
        'data-ctxex-grid': `${geometry.columns}x${geometry.rows}`,
      },
      items.map(item => h(Cell, {
        key: item.order,
        order: item.order,
        kind: item.kind,
        second: item.second,
        ring: item.ring,
        pickRef,
        // The hover names the kind and what one square is worth: the grid draws
        // no scale of its own, and a reader cannot tell 1k from 10k by looking.
        title: `${item.kind === null ? t('grid.free') : kindLabel(t, item.kind) + (item.second === null ? '' : ` + ${kindLabel(t, item.second)}`)} · ${fill(t('grid.perCell'), { tokens: formatTokens(geometry.tokensPerCell) })}`,
      }))))
    }

    /** One chip of the composition: kind, its count, its share, and a filter. */
    function Chip({ group, total, active, onPick, t }) {
      const share = total === 0 ? 0 : (group.tokens / total) * 100
      return h('button', {
        type: 'button',
        className: 'chip',
        'data-on': active ? 'true' : 'false',
        'data-ctxex-kind': group.kind,
        onClick: () => { onPick(group.kind) },
      },
        h('span', { className: 'swatch', style: { background: KIND_INK[group.kind] ?? KIND_INK.other } }),
        h('span', null, kindLabel(t, group.kind)),
        h('b', null, formatTokens(group.tokens)),
        h('span', { className: 'sub' }, `${share.toFixed(0)}%`))
    }

    /**
     * One region of the list, and the place a region is read.
     *
     * The row carries a colour, its text, and its price — nothing else. The
     * kind's name would repeat what the swatch already encodes against the
     * composition chips directly above, and the source label repeated itself
     * down hundreds of tool results ("tool", "tool", "tool"), so both are gone.
     * What makes a row identifiable is its flat text.
     *
     * Opened, the row is the reading surface, and what it shows is the region's
     * own fragment of the prompt the model receives — markers included — rather
     * than the same text without them. A region whose fragment the Host capped
     * says so, because a fragment that reads complete while being a fraction of
     * the text is exactly the kind of thing this panel exists to expose.
     */
    function Item({ region, total, open, onPick, register, t }) {
      const share = total === 0 ? 0 : (region.tokens / total) * 100
      const line = region.preview.replace(/\s+/g, ' ').trim()
      // A measured figure is the provider's own count for this region; the rest
      // carry the mark that says they are this plugin's estimate.
      const figure = region.measured === true
        ? formatTokens(region.tokens)
        : fill(t('item.approx'), { tokens: formatTokens(region.tokens) })
      // The region's own fragment of the served prompt, as the Host rendered it.
      const served = region.served
      // One test for "this region carries no text", used by the row and by the
      // body it opens: a fragment of nothing but whitespace reads the same in
      // both places instead of showing a blank block.
      const empty = served.replace(/\s+/g, ' ').trim() === ''
      return h('div', { className: 'itemWrap', ref: register, 'data-open': open ? 'true' : 'false' },
        h('button', {
          type: 'button',
          className: 'item',
          'data-on': open ? 'true' : 'false',
          'data-ctxex-row': region.order,
          title: line.slice(0, HOVER_LIMIT),
          onClick: () => { onPick(regionKey(region)) },
        },
          h('span', { className: 'swatch', style: { background: KIND_INK[region.kind] ?? KIND_INK.other } }),
          h('span', { className: 'itemSrc' }, line === '' ? t('detail.noText') : line),
          // The badge is for a closed row. Opened, the body says the same thing
          // where the reader is looking, so it is not said twice.
          open || region.truncated !== true ? null : h('span', { className: 'itemMark' }, t('detail.clipped')),
          h('span', { className: 'itemNum' }, `${figure} · ${share.toFixed(1)}%`)),
        open ? h('pre', { className: 'itemBody' },
          empty
            ? t('detail.noText')
            : (region.truncated === true ? `${served}\n\n${t('detail.clippedNote')}` : served)) : null)
    }

    /**
     * Show a rendering failure in place of a blank panel.
     *
     * A slot entry that throws renders nothing, and the only trace is a console
     * line the user has no reason to open; showing the message where the panel
     * would be turns a silent blank into a report.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      /**
       * Record a failure in a form that survives an absent or unusual error.
       *
       * `error.message` is not the only way a throw can arrive, and a boundary
       * that renders an empty box is worse than no boundary: it turns a crash
       * into a silent blank, which is the state this whole plugin exists to make
       * legible.
       */
      static getDerivedStateFromError(error) {
        let message
        try {
          if (error instanceof Error && typeof error.stack === 'string') message = error.stack
          else if (error instanceof Error) message = error.message
          else if (typeof error === 'string') message = error
          else message = `thrown value with no message: ${Object.prototype.toString.call(error)}`
        } catch {
          message = 'the thrown value could not be read'
        }
        return { error: message === '' ? 'thrown with an empty message' : message }
      }

      render() {
        if (this.state.error !== null) {
          // Every metric inline and the width taken from the viewport, because
          // this element is the boundary's own and no stylesheet rule reaches it:
          // a class here wraps nothing and the message then runs off the panel
          // edge, where the panel clips it and the report is lost.
          return h('div', {
            'data-ctxex': 'error',
            style: {
              boxSizing: 'border-box',
              width: '100%',
              maxWidth: '100%',
              maxHeight: '100%',
              overflow: 'auto',
              padding: '12px',
              margin: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              fontSize: '11px',
              lineHeight: 1.5,
              color: 'var(--dsw-alias-state-error-primary)',
            },
          }, this.state.error)
        }
        return this.props.children
      }
    }

    /**
     * The Explorer: the grid and the list share the panel, because they are the
     * two halves of one job. The grid is the way in — it answers "how full is
     * this, and is anything disproportionate" at a glance, which no list can.
     * The list is where the deciding happens: pick a square and its region comes
     * up here with enough text to judge whether it belongs.
     */
    function ContextExplorerPage({ useProjection, t }) {
      const [pickedKind, setPickedKind] = React.useState(null)
      const [pickedKey, setPickedKey] = React.useState(null)
      const [bySize, setBySize] = React.useState(false)
      const view = useProjection('contextExplorer')
      const styleEl = React.createElement('style', null, css)
      const geometry = useGridPlan(view === undefined ? null : view.contextWindow)
      // Row elements keyed by `region.order`, so a square can bring its region
      // into view without the page holding scroll state.
      const rowNodes = React.useRef(new Map())

      const pickKind = React.useCallback((kind) => {
        setPickedKind(current => (current === kind ? null : kind))
      }, [])
      const pickRegion = React.useCallback((key) => {
        setPickedKey(current => (current === key ? null : key))
      }, [])

      // The open row, narrowed by everything that can hide it, so a stale
      // selection can never outline or expand a row that is not on screen.
      //
      // Above the empty-view return because the effect below is a hook, and a
      // hook that runs on only some renders changes the hook count.
      const open = visibleOpenRow(view, pickedKey, pickedKind)
      React.useEffect(() => {
        if (open === null) return
        const node = rowNodes.current.get(open)
        if (node !== undefined) node.scrollIntoView({ block: 'nearest' })
        // `bySize` is a dependency because re-sorting moves the open row, and
        // this scroll is what keeps it visible after the list reorders.
      }, [open, bySize])

      // The shell fills whatever the tab hands it, and `minWidth: 0` is
      // load-bearing: a flex item defaults to `min-width: auto`, so without it a
      // long row sets the shell's floor and the panel grows past the sidebar.
      const shellStyle = {
        height: '100%',
        width: '100%',
        minWidth: 0,
        boxSizing: 'border-box',
        padding: '12px 12px 10px',
      }

      // Nothing published yet, and a published view with no region to draw, are
      // the same thing to a reader: there is no context to show, and an empty
      // shell with a zero headline and a blank grid reads as a broken panel
      // rather than as a session that has not sent anything.
      if (view === undefined || view.regions.length === 0) {
        return h(React.Fragment, null, styleEl, h('div', {
          className: 'ctxex', style: shellStyle, 'data-ctxex': 'empty',
        },
          h('div', { className: 'empty' },
            h('span', null, t('empty.title')),
            h('span', null, t('empty.body')))))
      }

      const regions = view.regions
      const total = view.totalTokens
      const groups = groupByKind(regions)
      // Spans index the whole region list, never the filtered one: `region.order`
      // is a position in this array, so building these from a filtered list
      // silently misaligns them and an open row then outlines the wrong squares
      // or none at all.
      const spans = spansOf(regions)
      const filtered = pickedKind === null ? regions : regions.filter(region => region.kind === pickedKind)
      // The model's own count of the last request, when a call has reported one:
      // it is the only figure here that this plugin did not price itself.
      const reported = view.reportPromptTokens > 0
      // Model-visible order by default, so the list reads as the same sequence
      // the grid draws and a square's row is where the eye expects it. Size order
      // is one click away for the other question — "what is eating this".
      const shown = bySize ? [...filtered].sort((left, right) => right.tokens - left.tokens) : filtered

      // The `data-*` attributes below are automation seams: `data-ctxex="page"`
      // and `data-ctxex-failure` mark the shell, `data-ctxex-cell`, `-row`,
      // `-kind`, `-grid`, `data-kind` and `data-ring` address one square, row,
      // chip or grid in a driven browser. Nothing styles them and nothing reads
      // them at runtime.
      return h(React.Fragment, null, styleEl, h('div', {
        className: 'ctxex', style: shellStyle, 'data-ctxex': 'page',
      },
      view.failure === null || view.failure === undefined ? null : h('span', {
        className: 'error', 'data-ctxex-failure': 'true',
      }, view.failure),
      // The headline figure is the provider's own count of the last request — the
      // one figure this plugin did not price. Before a call reports anything there
      // is only the panel's own total.
      h('div', { className: 'row' },
        h('span', { className: 'sub', title: t('grid.summaryNote') },
          fill(t('grid.summary'), {
            used: formatTokens(reported ? view.reportPromptTokens : total),
            total: view.contextWindow === null ? '—' : formatTokens(view.contextWindow),
          }))),
      // The composition figures wrap rather than overflow. In a narrow sidebar
      // they used to run past the panel edge, so the last kinds were simply not
      // on screen — and these chips double as the grid's legend, so a missing one
      // is a colour with no name.
      h('div', { className: 'row chipRow' },
        groups.map(group => h(Chip, {
          key: group.kind, group, total, t,
          active: pickedKind === group.kind,
          onPick: pickKind,
        }))),
      // The grid holds a fixed quarter of the panel, open region or not. A fixed
      // share means the geometry never moves under the cursor: opening a row
      // changes the list, not the grid, so the squares stay where they were and
      // the outline appears in place.
      //
      // A percentage basis on a flex item resolves against the container's
      // height, and the container's `gap` comes off the free space rather than
      // the basis, so the band is a true quarter of the panel.
      h('div', { className: 'gridBand' },
      h(SpaceGrid, {
        spans, total, geometry, t,
        // The open region's squares are outlined, so the list's answer to "which
        // one" and the grid's answer to "where" are visibly the same thing.
        ring: open,
        onPick: (order) => {
          // A square's identity is the region holding most of it — the same
          // overlap the square was painted from — and the list is where that
          // region becomes readable, so bring it up rather than inventing a
          // second place to read.
          const from = order * geometry.tokensPerCell
          const owner = dominantRegion(spans, from, from + geometry.tokensPerCell)
          if (owner === null) { setPickedKey(null); return }
          // Selecting a square outranks a kind filter: the answer must be on
          // screen, and the row may not be in the filtered list at all.
          setPickedKind(null)
          setPickedKey(regionKey(owner))
        },
      })),
      h('div', { className: 'row' },
        // The count is the label. A heading like "all regions" only restates the
        // count in the panel's internal vocabulary, and a kind name here would
        // restate the chip that is already selected above.
        h('span', { className: 'sub' },
          String(shown.length)),
        h('button', {
          type: 'button', className: 'chip listToggle',
          'data-on': bySize ? 'true' : 'false',
          onClick: () => { setBySize(current => !current) },
        }, bySize ? t('list.bySize') : t('list.byOrder'))),
      h('div', { className: 'list' },
      // Every region is rendered, with no cap. A truncated list cannot be the
      // place a square sends you: the rows past the cut have no element, so the
      // square's region cannot be scrolled to and the click looks dead. The list
      // is its own scroll container, so the cost of the extra rows is only DOM.
      shown.map(region => h(Item, {
        // Keyed by identity rather than position, so an insertion ahead of a row
        // does not discard and rebuild the rows after it.
        key: regionKey(region),
        region, total, t,
        open: open === region.order,
        onPick: pickRegion,
        register: (node) => {
          if (node === null) rowNodes.current.delete(region.order)
          else rowNodes.current.set(region.order, node)
        },
      })))))
    }

    /**
     * The chip's mark: the context window as a grid of squares, the free
     * remainder in a fainter tone — the panel's own reading, at 16px.
     *
     * Inlined rather than loaded from `icon.svg`, which the manifest already
     * declares for the plugin listing. A chip cannot fetch a file without a
     * request and a flash of empty space, and `currentColor` lets the chip's own
     * hover and active colours carry through.
     */
    function GridGlyph() {
      const cell = (x, y, width, opacity) => h('rect', {
        key: `${x}:${y}`, x, y, width, height: 4, rx: 0.9, opacity,
      })
      return h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16,
        fill: 'currentColor', 'aria-hidden': 'true',
        // Inline, not a class: this element is the slotted chip's own content,
        // and a panel stylesheet rule does not reach into it.
        style: { flex: 'none', verticalAlign: '-3px', marginRight: '6px' },
      },
      cell(3, 4, 5, 0.95), cell(9.3, 4, 5, 0.95), cell(15.6, 4, 5.4, 0.95),
      cell(3, 9.3, 5, 0.8), cell(9.3, 9.3, 5, 0.95), cell(15.6, 9.3, 5.4, 0.8),
      cell(3, 14.6, 5, 0.6), cell(9.3, 14.6, 5, 0.45), cell(15.6, 14.6, 5.4, 0.35))
    }

    /**
     * The tab chip's title.
     *
     * The layout is inline because this element lives in the tab strip, outside
     * the panel subtree: the panel's own stylesheet is mounted by the page body,
     * which does not exist until the tab is opened, and its rules are scoped under
     * `.ctxex` in any case.
     */
    function ContextExplorerTitle({ t }) {
      return h('span', { style: { display: 'inline-flex', alignItems: 'center' } },
        h(GridGlyph, null), t('tab.title'))
    }

    return {
      inject: ['slots', 'locale', 'sidebarRightTabs'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'context-explorer: dictionaries')
        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          // The registry calls every thunk on each use, so a language change
          // needs no re-registration.
          title: () => ctx.locale.bind(NS)('tab.title'),
          guide: [{
            id: TAB_ID,
            order: 40,
            title: () => ctx.locale.bind(NS)('tab.title'),
            description: () => ctx.locale.bind(NS)('guide.description'),
          }],
        }), 'context-explorer: sidebar type')
        // `Boundary` renders its children directly and owns the styles of the
        // box it shows on failure, so the pane supplies no props of its own.
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
        }, function ContextExplorerBound({ t, ...rest }) {
          return h(Boundary, null, h(ContextExplorerPage, { t, ...rest }))
        }))
        ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
        }, ContextExplorerTitle))
      },
      /**
       * The pure helpers, exposed for direct testing.
       *
       * These decide which region a click opens, whether the selection survives
       * the next publish, and which squares belong to it, and each has been wrong
       * once: a filtered region list misaligned every span, a stale order outlined
       * a row that was not on screen, the click path scanned the spans a second
       * time, and a positional selection re-pointed itself when a region was
       * inserted ahead of it. They live inside this factory, so without an export
       * the only way to reach them is a rendered tree, which this environment
       * cannot reproduce faithfully. Named with a leading underscore so nothing
       * mistakes it for plugin surface.
       */
      __test: {
        visibleOpenRow, regionKey, coversRegion, resolveCell, dominantRegion,
        overlapsOf, spansOf, groupByKind, cellFill, gridPlanFor, devicePx,
      },
    }
  },
})

