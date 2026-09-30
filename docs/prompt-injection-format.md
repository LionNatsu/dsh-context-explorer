# How a Harness conversation becomes the prompt the model reads

The reference behind the Context Explorer's `served` text: which markers the
DeepSeek prompt is built from, how one message renders, and how the DeepSeek
Harness's request body becomes that prompt. Citations name a file and a symbol,
never a line number, because line numbers rot. `serve.js` in this repository is
the transcription of the rendering rules; `tools/prompt-golden.mjs` compares its
output with the official Python encoder byte for byte.

Two implementations are cited:

- the installed build, `@deepseek-ai/dsh` **0.2.0-rc.2**, whose packages are
  addressed here as `dsh-<name>/lib/...`;
- the DeepSeek serving implementation in the `deepseek-recipe` tree
  (`deepseek-recipe-encoding/src/v4/...`, `deepseek-recipe/src/protocol/anthropic/...`),
  which is what the hosted API runs. It is published at
  <https://github.com/deepseek-ai/deepseek-recipe>, and the encoder
  `tools/prompt-golden.mjs` compares against ships with the open weights at
  `encoding/encoding.py` in <https://github.com/deepseek-ai/DeepSeek-V4.1-Flash>.
  A DSH request never carries the rendered
  prompt: the log holds the structured body, and the API renders it server-side.

---

## 1. One request, three layers

`buildRequest` in `dsh-agent-loop` freezes the request body from the step's
config, the surface's derived messages, and the current tool schemas;
`canonicalHeader` in `dsh-session` is the logged form of the same header
(`{ config, adapterDefaults?, tools? }`).

| Layer | Produced by | Where it lands |
|---|---|---|
| Ordered system-prompt sections | `ctx.systemPrompt.section(...)`, assembled and joined by `renderPrompt` | the request's top-level `system` string |
| Tool schemas | `ctx.tools` providers, ordered before the header is logged | the request's `tools[]` |
| Message history | the session log's surface, through `Session.deriveMessages()` | the request's `messages[]` |

The header type has **no `system` field**: the rendered prompt is committed to the
log as a `system/message` surface node, and the adapter hoists the first one into
the request's `system` string. Runtime context (sandbox, approval and delegation
policy, time, cwd) is not part of that prompt: `RuntimeContextProjection.project`
in `dsh-agent-loop` commits it as a **user-role** message whose `source` is
`{ kind: 'runtime-context', form: 'snapshot' }`, so it travels in `messages`.

`renderPrompt` in `dsh-system-prompt` joins the sections in order with one blank
line and drops empty ones. That blank line is the only boundary the durable record
keeps, which is why the panel hands the prompt on whole instead of splitting it.

---

## 2. From request body to prompt text

`dsh-llm-deepseek`'s `serialize` turns the derived messages into an
Anthropic-Messages-shaped body and posts it to the messages endpoint of its
`baseURL` (default `https://api.deepseek.com/anthropic`). The serving side then
runs two conversions:

1. **The Messages-API compatibility layer** —
   `deepseek-recipe/src/protocol/anthropic/messages/request/convert.rs`,
   `transform_messages` — turns the request into the serving stack's own input
   messages. This is the layer that decides what role a message ends up with.
2. **The renderer** — `deepseek-recipe-encoding/src/v4/mod.rs`,
   `render_conversation` / `render_message` — writes the prompt from those input
   messages, with V4.1's markers and effort line from
   `deepseek-recipe-encoding/src/v4/dsv41.rs`.

`serve.js` transcribes both for the cases a DSH session produces: the renderer's
rules directly, and the compatibility layer's one rewriting decision that changes
what the model reads (§5).

---

## 3. The markers

| Constant (`serve.js`) | Text | Opens / closes |
|---|---|---|
| `BOS` | `<｜begin▁of▁sentence｜>` | the prompt |
| `EOS` | `<｜end▁of▁sentence｜>` | every assistant message |
| `SYSTEM` | `<｜System｜>` | a system message |
| `USER` | `<｜User｜>` | a user message, and a tool result |
| `ASSISTANT` | `<｜Assistant｜>` | an assistant message, and the reply header |
| `REMINDER` | `<｜latest_reminder｜>` | a latest-reminder message |
| `THINK_OPEN` / `THINK_CLOSE` | `<think>` / `</think>` | an assistant turn's reasoning |
| `DSML` | `｜DSML｜` | a tool-call tag name |
| `CALLS_TAG` / `CALL_TAG` / `PARAMETER_TAG` | ` calls` / ` invoke` / ` parameter` | the call block, one call, one argument |

The three tool tag names each begin with the space that follows the marker, so a
call renders as `<｜DSML｜ invoke name="…">`.

---

## 4. How one message renders

`renderFragment` decides a message's fragment from the message and its position.
`renderMessage` calls it for message `i` of the conversation; the panel calls it
per region with the same position facts.

- **The effort line.** In thinking mode the first fragment writes `Reasoning
  Effort: <score> (range 1-100, the higher the value, the more thorough the
  reasoning)` and a blank line directly after the opening `<｜System｜>` marker. The
  score comes from `reasoning_effort_template` in `dsv41.rs`: `low` → 50, **nothing,
  `high` and `xhigh` → 75**, `max` → 100. So four configured efforts collapse to
  three numbers, and a route that declares none still says 75.
- **System.** A first system message writes `<｜System｜>` and its text. A system
  message later in the array writes `<｜System｜>` again before its text — the
  renderer's own rule; at the API layer that same message never reaches the
  renderer as a system message (§5).
- **User.** `<｜User｜>` and the text, or just a blank line when the previous
  message was a user or tool message: consecutive user-role content is one turn,
  and one marker opens it.
- **Tool result.** `<｜User｜>` (or the joining blank line) and
  `<tool_result>…</tool_result>`. Nothing marks an error result (§5).
- **Assistant.** `<｜Assistant｜>`, then the thinking state, then the body:
  - in thinking mode and not the first message, `<think>`, the message's
    reasoning and `</think>`;
  - otherwise `</think>` alone — the close marker is always written, which is what
    tells the model where reasoning ended even when there was none;
  - then the text, then the tool calls, then `<｜end▁of▁sentence｜>`.
- **Tool calls.** All of one message's calls sit in one block:
  `<｜DSML｜ calls>` around them, `<｜DSML｜ invoke name="…">` per call, and
  `<｜DSML｜ parameter name="…" string="true|false">…</｜DSML｜ parameter>` per
  argument. A string argument is written as-is with `string="true"`; anything else
  is written as JSON with `string="false"`.
- **The head.** The prompt closes with `<｜Assistant｜><think>` when the route
  renders thinking and `<｜Assistant｜></think>` when it does not. That header
  belongs to no message, so the panel does not draw it.

**Normalization** (`normalizeMessages`) runs before rendering: adjacent user
messages are joined with a blank line, and a run of tool results is reordered to
the order of the calls they answer.

---

## 5. The Harness → request mapping

`serialize` in `dsh-llm-deepseek` builds the body from the derived messages:

| DSH message | Entry in the request |
|---|---|
| System prompt, not `in-history` | captured and hoisted out of `messages` into the top-level `system` string |
| System prompt, `in-history`, after a preceding message | `{ role: 'system', content: [{ type: 'text', text }] }` **inside** `messages`, pushed only after a user or tool-result turn |
| `developer` message, text blocks | the same `{ role: 'system' }` entry |
| `developer` message, `tool-addition` / `tool-removal` | `{ type: 'tool_addition' \| 'tool_removal', tool: { type: 'tool_reference', name } }` inside that system entry |
| `user` message | `{ role: 'user', content }` |
| `assistant` message | `{ role: 'assistant', content }`, with reasoning and tool calls as typed content |
| `tool` result | role rewritten to `'user'`, with `{ type: 'tool_result', tool_use_id, content, is_error? }` |

The serializer enforces the protocol instead of trusting the log: adjacent
same-role messages merge into one entry, an empty user message is dropped, a
user turn's `tool_result` blocks are moved to the front of its content, a tool
result with no matching pending call or a duplicate call id is rejected
(`INVALID_REQUEST`), and a system update with no preceding user or tool-result
turn is rejected. The adapter also refuses to be reconfigured into another
protocol.

**The compatibility layer then changes two of those roles.** In `convert.rs`,
`transform_messages`:

1. the top-level `system` string becomes an `InputMessage::System`, which the
   renderer writes as `<｜System｜>`;
2. **a `role: 'system'` entry inside `messages` becomes an `InputMessage::User`
   whose content is wrapped in `<system-reminder>\n…\n</system-reminder>`** — the
   schema calls it a compatibility extension "rendered as a user system-reminder".
   So an `in-history` prompt change, and a `developer` message, reach the model
   as a `<｜User｜><system-reminder>` turn, not as a second `<｜System｜>`. The
   `<｜System｜>` block holds the prompt the adapter hoisted, which is the earliest
   system message in the conversation, not the newest one.

Three facts that follow, each of which changes what a reader sees in the panel:

- **An `in-history` prompt is a user turn.** Its region is served as
  `<system-reminder>`; `index.js`'s `servedMessageOf` renders exactly that for a
  system node other than the hoisted one, and for a developer message. The prompt
  a reader should treat as the instructions in force is still the newest one: it
  arrives as a reminder, and the panel shows it that way.
- **`is_error` is accepted and dropped.** The wire schema declares
  `is_error: Option<bool>` on a tool result and forwards it when DSH sets it, but
  nothing in the recipe consumes it: the rendered result is
  `<tool_result>…</tool_result>`, with no error marking. (Confirmed by the recipe
  tree: `is_error` appears only in the schema.)
- **Reasoning effort collapses to 50 / 75 / 100** (§4), so the number in the
  prompt is not the configured effort name.

---

## 6. The tool block

`render_tool_prompt` in `mod.rs` builds one block from the request's `tools[]`:

```
## Tools

You have access to a set of tools … You can invoke tools by writing a "<｜DSML｜ calls>" block like the following:
…a worked example…
String parameters should be specified as is and set `string="true"`. For all other types … `string="false"`.

If thinking_mode is enabled (triggered by <think>), you MUST output your complete reasoning inside <think>...</think> BEFORE any tool calls or final response.

Otherwise, output directly after </think> with tool calls or final response.

### Available Tool Schemas

{"name": "…", "description": "…", "parameters": {…}}
{"name": "…", "description": "…", "parameters": {…}}

You MUST strictly follow the above defined tool name and parameter schemas to invoke tool calls.
```

`renderConversation` appends that block to the first system message, after a blank
line (inserting an empty system message when the conversation has none), so the
schema lines are part of the system fragment and the panel draws them as their own
region.

The key inside those lines is **`parameters`** — the name the session log and the
prompt use. The adapter re-emits the same array with **`input_schema`** when it
builds the request body, so the request and the prompt name the same value
differently.

---

## 7. Token accounting

The Harness prices content, not the rendered prompt. `dsh-token-meter`'s
`estimate.js` is the single estimator behind both its meter service and its
`contextBreakdown` projection, and `estimate.js` in this repository copies it:
`CHARS_PER_TOKEN = 4`, `BLOCK_OVERHEAD = 4`, `ROLE_OVERHEAD = 4`.

- `estimateContent`: `ceil(characters / 4) + 4` per text or reasoning block,
  `ceil(name / 4) + ceil(arguments / 4) + 4` per tool call, and the block's JSON
  structure for anything else.
- `estimateSystemMessage`: `ceil(characters / 4) + 4` with no per-block overhead,
  because the prompt is serialized as a plain string; no content blocks price 0.
- `estimateToolsTokens`: `ceil(JSON.stringify(tools).length / 4) + 4` on the
  envelope.

It prices text by UTF-16 code units rather than by tokens, and it adds framing of
its own per block and per message instead of the markers the prompt actually
carries, so an estimated figure is a magnitude for composition, not a count.
`view.reportPromptTokens`, and a region whose `measured` is true, are the
provider's own counts and carry no such error.

---

## 8. Where each fact comes from

| Fact | Source |
|---|---|
| Request body, `canonicalHeader`, developer tool-change messages | `dsh-agent-loop` (`buildRequest`), `dsh-session` (`canonicalHeader`) |
| Prompt sections joined by one blank line, empty sections dropped | `dsh-system-prompt` (`renderPrompt`) |
| Runtime context is a user-role message with `source.kind` | `dsh-agent-loop` (`RuntimeContextProjection.project`), `dsh-system-prompt` (`joinContextSections`) |
| Hoisted `system`, in-history/developer system entries, tool-result rewrite, protocol invariants | `dsh-llm-deepseek` (`serialize`) |
| Mid-array system → user + `<system-reminder>`; top-level system → `InputMessage::System` | `deepseek-recipe`: `protocol/anthropic/messages/request/convert.rs` (`transform_messages`), `…/schema.rs` |
| `is_error` declared but never consumed | `deepseek-recipe`: `…/request/schema.rs` (only occurrence in the tree) |
| Markers, effort line, per-role rendering, tool block, normalization | `deepseek-recipe-encoding/src/v4/mod.rs`, `v4/dsv41.rs`; transcribed in `serve.js` |
| The rendered prompt is an `InputMessage` list, not the request body | `deepseek-recipe-encoding/src/v4/mod.rs` (`render_conversation`) |
| Estimator constants, formulas and the drift warning | `dsh-token-meter`: `types/estimate.js`; copied in `estimate.js` |
| The transcription is faithful | `tools/prompt-golden.mjs` against the official `encoding/encoding.py`, fixtures in `tools/prompt-golden.json` |
