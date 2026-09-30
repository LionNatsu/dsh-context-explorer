/**
 * Byte comparison of `serve.js` against the official DeepSeek encoder.
 *
 * `serve.js` transcribes the serving renderer from the DeepSeek recipe. This
 * check renders the fixtures in `prompt-golden.json` through it and compares
 * every character with `expected[]`, which is output of the official encoder
 * named in that file's `source`. A transcription that drifts by one space or one
 * marker fails here rather than in the panel.
 *
 * The encoder is Python and lives outside this repository, so the comparison is
 * offline by default and `--regenerate` re-derives the expected strings when the
 * encoder is on hand:
 *
 *   node tools/prompt-golden.mjs --regenerate --encoder <path to encoding.py>
 *
 * Regeneration needs `py -3` or `python`. Run without arguments for the check.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { renderConversation } from '../serve.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const GOLDEN = `${HERE}/prompt-golden.json`

/** Read the fixtures and their expected prompts. */
function load() {
  return JSON.parse(readFileSync(GOLDEN, 'utf8'))
}

/**
 * Turn a fixture into the conversation `serve.js` renders.
 *
 * The fixture is written once, in the backend's own vocabulary, so the same
 * messages feed both this port and the Python adapter below.
 * @param fixture - one entry of `fixtures`.
 * @returns the conversation.
 */
export function toConversation(fixture) {
  return {
    thinking: fixture.thinking === true,
    effort: fixture.effort ?? undefined,
    tools: fixture.tools ?? [],
    messages: fixture.messages.map(message => ({
      role: message.role,
      content: message.content ?? '',
      reasoning: message.reasoning,
      toolCalls: message.toolCalls,
      toolCallId: message.toolCallId,
    })),
  }
}

/**
 * The Python program that renders the fixtures with the official encoder.
 *
 * The encoder speaks the OpenAI-style message shape, so the adapter here is the
 * same mapping the backend's Anthropic converter performs: tools attach to the
 * first system message, a tool result becomes a `tool_result` content block of a
 * user message, and reasoning and tool calls keep their own fields.
 */
const PYTHON = `
import importlib.util, json, sys
encoder_path = sys.argv[1]
spec = importlib.util.spec_from_file_location("dsv41_encoder", encoder_path)
encoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(encoder)

data = json.loads(sys.argv[2])
out = {}
for fixture in data["fixtures"]:
    tools = [{"type": "function",
              "function": {"name": tool["name"],
                           "description": tool.get("description", ""),
                           "parameters": tool["parameters"]}}
             for tool in fixture.get("tools", [])]
    messages = []
    for index, message in enumerate(fixture["messages"]):
        role = message["role"]
        if role == "system":
            entry = {"role": "system", "content": message["content"]}
            if index == 0 and tools:
                entry["tools"] = tools
        elif role == "assistant":
            entry = {"role": "assistant", "content": message.get("content", "")}
            if message.get("reasoning"):
                entry["reasoning_content"] = message["reasoning"]
            if message.get("toolCalls"):
                entry["tool_calls"] = [{"id": call["id"], "type": "function",
                                        "function": {"name": call["name"],
                                                     "arguments": call["arguments"]}}
                                       for call in message["toolCalls"]]
        elif role == "tool":
            entry = {"role": "user",
                     "content_blocks": [{"type": "tool_result", "content": message["content"]}]}
        else:
            entry = {"role": role, "content": message["content"]}
        messages.append(entry)
    out[fixture["name"]] = encoder.encode_messages(
        messages,
        thinking_mode="thinking" if fixture.get("thinking") else "chat",
        reasoning_effort=fixture.get("effort"),
        drop_thinking=False,
    )
sys.stdout.write(json.dumps(out, ensure_ascii=False))
`

/** Run the official encoder and return one prompt per fixture. */
function encodeWithReference(encoderPath, fixtures) {
  const python = process.env.DSH_PYTHON ?? (process.platform === 'win32' ? 'py' : 'python3')
  // `py -3 -` reads the program from stdin, so the encoder path and the fixtures
  // travel as arguments behind it.
  const program = ['-3', '-', encoderPath, JSON.stringify({ fixtures })]
  const args = process.platform === 'win32' ? program : program.slice(1)
  const run = spawnSync(python, args, {
    input: PYTHON,
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 64 * 1024 * 1024,
  })
  if (run.error !== undefined) throw new Error(`cannot run ${python}: ${run.error.message}`)
  if (run.status !== 0) throw new Error(`${python} exited ${run.status}: ${run.stderr.trim()}`)
  return JSON.parse(run.stdout)
}

/** First place two strings differ, with a little context. */
function firstDifference(actual, expected) {
  const limit = Math.min(actual.length, expected.length)
  for (let index = 0; index < limit; index += 1) {
    if (actual[index] !== expected[index]) {
      return { index, actual: actual.slice(Math.max(0, index - 40), index + 40), expected: expected.slice(Math.max(0, index - 40), index + 40) }
    }
  }
  if (actual.length === expected.length) return null
  return { index: limit, actual: actual.slice(Math.max(0, limit - 40), limit + 40), expected: expected.slice(Math.max(0, limit - 40), limit + 40) }
}

const argv = process.argv.slice(2)
const encoderFlag = argv.indexOf('--encoder')
const encoderPath = encoderFlag === -1 ? process.env.DSH_ENCODING_PY : argv[encoderFlag + 1]
const golden = load()

if (argv.includes('--regenerate')) {
  if (encoderPath === undefined) {
    console.error('--regenerate needs --encoder <path to encoding.py> or DSH_ENCODING_PY')
    process.exit(2)
  }
  golden.expected = encodeWithReference(encoderPath, golden.fixtures)
  golden.source.generated = new Date().toISOString().slice(0, 10)
  writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`, 'utf8')
  console.log(`wrote ${Object.keys(golden.expected).length} expected prompt(s) from ${encoderPath}`)
  for (const [name, prompt] of Object.entries(golden.expected)) console.log(`  ${name}: ${prompt.length} chars`)
  process.exit(0)
}

let failures = 0
let checks = 0
for (const fixture of golden.fixtures) {
  checks += 1
  const expected = golden.expected[fixture.name]
  if (typeof expected !== 'string') {
    console.log(`  FAIL ${fixture.name} — no expected prompt; run --regenerate`)
    failures += 1
    continue
  }
  const { prompt } = renderConversation(toConversation(fixture))
  const difference = firstDifference(prompt, expected)
  if (difference === null) {
    console.log(`  ok   ${fixture.name} — ${prompt.length} chars`)
  } else {
    failures += 1
    console.log(`  FAIL ${fixture.name} — first difference at ${difference.index}`)
    console.log(`       ours: ${JSON.stringify(difference.actual)}`)
    console.log(`       ref : ${JSON.stringify(difference.expected)}`)
  }
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
