/**
 * Token pricing for the Context Explorer.
 *
 * This reproduces the DeepSeek Harness's fixed-density estimator verbatim —
 * constants and arithmetic included — so the Explorer's figures equal the ones
 * the shipped `contextBreakdown` projection and `ctx.tokenMeter` report for the
 * same content. Pricing is duplicated here rather than imported because an
 * installed profile bundle resolves its own imports from its own directory,
 * where the Harness's packages are not visible; keeping the four constants and
 * five functions local is what makes this bundle portable.
 *
 * The Harness calls this "a fixed heuristic until exact tokenization is
 * needed". It systematically underprices CJK text and JSON schemas, so treat
 * every figure as an approximation of composition, never as a billable count.
 *
 * @module dsh-context-explorer/estimate
 */

/** Fixed text-density estimate: one token per four UTF-16 code units. */
export const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
export const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block) {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(reference).length / CHARS_PER_TOKEN)
  }
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks) {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      default:
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt. Adapters serialize it as a plain string —
 * the request's `system` field, not a typed content block — so the price is
 * text density plus role framing and no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content.
 */
export function estimateSystemMessage(message) {
  if (message.content.length === 0) return 0
  let characters = 0
  for (const block of message.content) {
    characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens; a system message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message) {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a request envelope.
 * @param tools - the envelope's tool schemas, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(tools) {
  if (tools === undefined || tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}
