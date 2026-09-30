/**
 * The prompt text the DeepSeek backend builds from a conversation.
 *
 * Transcribed from the serving implementation in the DeepSeek recipe, so the
 * panel can show a region in the form the model receives rather than in this
 * plugin's own words:
 *
 * - `deepseek-recipe-encoding/src/v4/mod.rs` — `render_conversation`,
 *   `render_message`, `render_tool_prompt`, `normalize_messages`.
 * - `deepseek-recipe-encoding/src/v4/dsv41.rs` — the V4.1 marker names and the
 *   numeric reasoning-effort line.
 * - `deepseek-recipe-core/src/util/json_formatter.rs` — the JSON style used
 *   inside the prompt: Python's `json.dumps` spacing, non-ASCII unescaped.
 *
 * It is a transcription, not a capture. The Harness talks to the hosted API,
 * which renders server-side; this file reproduces what the published serving
 * implementation renders from the same conversation. Every rule below names the
 * file it came from, and `tools/prompt-golden.mjs` checks the result byte for
 * byte against the official Python encoder for the same conversation.
 *
 * @module dsh-context-explorer/serve
 */

/** Marks the start of the prompt. */
const BOS = '<｜begin▁of▁sentence｜>'/** Terminates an assistant message. */
const EOS = '<｜end▁of▁sentence｜>'
/** Starts a system message. */
const SYSTEM = '<｜System｜>'
/** Starts a user message. */
const USER = '<｜User｜>'
/** Starts an assistant message. */
const ASSISTANT = '<｜Assistant｜>'
/** Starts a latest-reminder message. */
const REMINDER = '<｜latest_reminder｜>'
/** Starts and ends the reasoning content of an assistant turn. */
const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'
/** Marks the start of a tool-call markup tag, inside the angle brackets. */
const DSML = '｜DSML｜'
/** V4.1 tag names, each beginning with the space that follows the marker. */
const CALLS_TAG = ' calls'
const CALL_TAG = ' invoke'
const PARAMETER_TAG = ' parameter'

/** The reasoning-effort scores of `ReasoningEffort`, from `dsv41.rs`. */
const EFFORT_SCORES = { low: 50, high: 75, xhigh: 75, max: 100 }

/**
 * Every marker the prompt is built from, for callers that draw or look for them.
 * The V4.1 tool tag names each begin with the space that follows the marker.
 */
export const MARKERS = Object.freeze({
  BOS,
  EOS,
  SYSTEM,
  USER,
  ASSISTANT,
  REMINDER,
  THINK_OPEN,
  THINK_CLOSE,
  DSML,
  CALLS_TAG,
  CALL_TAG,
  PARAMETER_TAG,
})

/**
 * Serialize a value the way the prompt does.
 *
 * `json.dumps` writes `", "` and `": "` between items, leaves non-ASCII text
 * unescaped, and keeps object keys in insertion order. Numbers keep their
 * JavaScript form: every value here has already round-tripped through JSON, so
 * an integer is an integer on both sides of the wire.
 * @param value - any JSON value.
 * @returns the value as the prompt carries it.
 */
export function stringifyPythonStyle(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stringifyPythonStyle).join(', ')}]`
  const fields = Object.entries(value)
    .map(([key, item]) => `${JSON.stringify(key)}: ${stringifyPythonStyle(item)}`)
  return `{${fields.join(', ')}}`
}

/**
 * One tool call as the model must write it back: a tag per call, a tag per
 * argument, string arguments flagged.
 * @param toolCall - the call's name and its arguments object or JSON string.
 * @returns the call's markup.
 */
function renderToolCall(toolCall) {
  const arguments_ = typeof toolCall.arguments === 'string'
    ? parseArguments(toolCall.arguments)
    : (toolCall.arguments ?? {})
  const parameters = Object.entries(arguments_)
    .map(([key, value]) => `<${DSML}${PARAMETER_TAG} name="${key}" string="${typeof value === 'string' ? 'true' : 'false'}">${typeof value === 'string' ? value : stringifyPythonStyle(value)}</${DSML}${PARAMETER_TAG}>`)
    .join('\n')
  return `<${DSML}${CALL_TAG} name="${toolCall.name}">\n${parameters}\n</${DSML}${CALL_TAG}>`
}

/** Arguments are a JSON object; anything else keeps the raw text, as the recipe does. */
function parseArguments(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { arguments: text }
  } catch {
    return { arguments: text }
  }
}

/** All of one assistant message's tool calls, or an empty string when it has none. */
function renderToolCalls(toolCalls) {
  if (toolCalls === undefined || toolCalls.length === 0) return ''
  const calls = toolCalls.map(renderToolCall).join('\n')
  return `\n\n<${DSML}${CALLS_TAG}>\n${calls}\n</${DSML}${CALLS_TAG}>`
}

/**
 * The tool block, which the backend appends to the system message.
 * @param tools - definitions with `name`, `description` and `parameters`.
 * @returns the block, schemas one per line.
 */
export function renderToolPrompt(tools) {
  const schemas = tools.map(tool => stringifyPythonStyle({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.parameters,
  })).join('\n')
  return `## Tools

You have access to a set of tools to help answer the user's question. You can invoke tools by writing a "<${DSML}${CALLS_TAG}>" block like the following:

<${DSML}${CALLS_TAG}>
<${DSML}${CALL_TAG} name="$TOOL_NAME">
<${DSML}${PARAMETER_TAG} name="$PARAMETER_NAME" string="true|false">$PARAMETER_VALUE</${DSML}${PARAMETER_TAG}>
...
</${DSML}${CALL_TAG}>
<${DSML}${CALL_TAG} name="$TOOL_NAME2">
...
</${DSML}${CALL_TAG}>
</${DSML}${CALLS_TAG}>

String parameters should be specified as is and set \`string="true"\`. For all other types (numbers, booleans, arrays, objects), pass the value in JSON format and set \`string="false"\`.

If thinking_mode is enabled (triggered by ${THINK_OPEN}), you MUST output your complete reasoning inside ${THINK_OPEN}...${THINK_CLOSE} BEFORE any tool calls or final response.

Otherwise, output directly after ${THINK_CLOSE} with tool calls or final response.

### Available Tool Schemas

${schemas}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
`
}

/**
 * The reasoning-effort line, which opens a thinking-mode prompt.
 * @param effort - `low`, `high`, `xhigh`, `max`, or nothing.
 * @returns the line and its blank line, or an empty string.
 */
function renderReasoningEffort(effort) {
  const score = EFFORT_SCORES[effort] ?? EFFORT_SCORES.high
  return `Reasoning Effort: ${score} (range 1-100, the higher the value, the more thorough the reasoning)\n\n`
}

/**
 * One message's own text, as it appears in the prompt.
 *
 * A user or tool message that follows another user or tool message is joined to
 * it with a blank line instead of opening a new marker, which is why this needs
 * the message's position rather than the message alone.
 * @param messages - the whole conversation, in order.
 * @param index - the message to render.
 * @param options - `thinking` and `effort` for the conversation.
 * @returns the message's fragment of the prompt.
 */
function renderMessage(messages, index, options) {
  return renderFragment(messages[index], {
    first: index === 0,
    previous: index === 0 ? undefined : messages[index - 1],
    thinking: options.thinking,
    effort: options.effort,
  })
}

/**
 * One message's fragment, decided by the message and what precedes it.
 *
 * This is the function `renderConversation` calls per message; a caller that
 * draws messages one at a time calls it directly, with `first` and `previous`
 * taken from the conversation the backend would send.
 * @param message - the message, as an `InputMessage`.
 * @param place - `first`, `previous`, `thinking` and `effort`.
 * @returns the message's fragment of the prompt.
 */
export function renderFragment(message, place) {
  const { first, previous, thinking, effort } = place
  const preamble = first === true && thinking === true ? renderReasoningEffort(effort) : ''
  let text = first === true && (preamble !== '' || message.role === 'system') ? SYSTEM : ''
  text += preamble
  switch (message.role) {
    case 'system':
      // V4.1 keeps a system message mid-conversation and marks it again.
      if (first !== true) text += SYSTEM
      text += message.content
      break
    case 'user':
      text += isJoined(previous) ? '\n\n' : USER
      text += message.content
      break
    case 'tool':
      text += isJoined(previous) ? '\n\n' : USER
      text += `<tool_result>${message.content}</tool_result>`
      break
    case 'latest_reminder':
      text += REMINDER
      text += message.content
      break
    case 'assistant': {
      const calls = renderToolCalls(message.toolCalls)
      // Reasoning is kept only for a message after the first, and only in
      // thinking mode; the closing marker is always present, which is what
      // tells the model where the reasoning ended.
      const kept = thinking === true && first !== true
        ? `${message.reasoning ?? ''}${THINK_CLOSE}`
        : ''
      text += ASSISTANT
      text += kept === '' ? THINK_CLOSE : THINK_OPEN
      text += kept
      text += message.content
      text += calls
      text += EOS
      break
    }
    default:
      throw new Error(`context explorer: cannot render a ${message.role} message`)
  }
  return text
}

/** Whether this message continues the previous one instead of opening a marker. */
function isJoined(previous) {
  return previous !== undefined && (previous.role === 'user' || previous.role === 'tool')
}

/**
 * Fold consecutive messages the way the backend does before rendering: adjacent
 * user messages join with a blank line, and tool results are put back into the
 * order their calls appear in.
 * @param messages - the conversation in order.
 * @returns the conversation the renderer sees.
 */
export function normalizeMessages(messages) {
  const normalized = []
  for (const message of messages) {
    const previous = normalized[normalized.length - 1]
    if (message.role === 'user' && previous !== undefined && previous.role === 'user') {
      normalized[normalized.length - 1] = { ...previous, content: `${previous.content}\n\n${message.content}` }
      continue
    }
    normalized.push(message)
  }
  return sortToolResults(normalized)
}

/** Put a run of tool results into the order of the calls they answer. */
function sortToolResults(messages) {
  let order = []
  let index = 0
  while (index < messages.length) {
    const message = messages[index]
    if (message.role === 'assistant' && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      order = message.toolCalls.map(call => call.id)
      index += 1
      continue
    }
    if (message.role === 'user' || message.role === 'tool') {
      const start = index
      while (index < messages.length && (messages[index].role === 'user' || messages[index].role === 'tool')) index += 1
      const positions = []
      for (let at = start; at < index; at += 1) if (messages[at].role === 'tool') positions.push(at)
      if (positions.length > 1 && order.length > 0) {
        const tools = positions.map(at => messages[at])
        tools.sort((left, right) => rank(order, left.toolCallId) - rank(order, right.toolCallId))
        positions.forEach((at, position) => { messages[at] = tools[position] })
      }
      continue
    }
    index += 1
  }
  return messages
}

/** A tool result's position in its call order; an unknown id keeps the first place. */
function rank(order, id) {
  const at = order.indexOf(id)
  return at === -1 ? 0 : at
}

/**
 * The whole prompt, and each message's own share of it.
 *
 * `fragments[i]` is what `renderMessage` produced for message `i`, so a caller
 * that draws messages one at a time can show each in its served form. The
 * prompt is the byte string the backend renders: the start marker, every
 * fragment in order, and the assistant header that opens the reply.
 *
 * The tool block and the response format are appended to the first system
 * message before rendering, exactly as the backend does, so the caller must
 * include the tools in `tools` rather than in any message's content.
 * @param conversation - `messages`, `tools`, `thinking` and `effort`.
 * @returns the prompt and the per-message fragments.
 */
export function renderConversation(conversation) {
  const messages = normalizeMessages(conversation.messages.map(message => ({ ...message })))
  const tools = conversation.tools ?? []
  if (tools.length > 0) {
    if (messages.length === 0 || messages[0].role !== 'system') {
      messages.unshift({ role: 'system', content: '' })
    }
    const head = messages[0]
    head.content = `${head.content}\n\n${renderToolPrompt(tools)}`
  }
  const options = { thinking: conversation.thinking === true, effort: conversation.effort }
  const fragments = messages.map((_, index) => renderMessage(messages, index, options))
  const head = `${ASSISTANT}${options.thinking ? THINK_OPEN : THINK_CLOSE}`
  return { messages, fragments, head, prompt: `${BOS}${fragments.join('')}${head}` }
}
