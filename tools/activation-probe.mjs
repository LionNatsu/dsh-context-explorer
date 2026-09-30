/**
 * Probe: mount the Context Explorer exactly as the Loader does and report
 * whether its key reaches a projection snapshot.
 *
 * Run from the profile directory, naming this checkout's own absolute path:
 *   node --import "file:///<repo>/tools/profile-resolver.mjs" <repo>/tools/activation-probe.mjs
 *
 * This file is a diagnostic tool, not part of the installed plugin. It is the
 * check that proves the Host half activates, which no fold-level test can: the
 * unit can fold a log perfectly and still never register, and then the panel
 * shows nothing at all.
 *
 * The Harness packages live in an installed profile rather than in this
 * workspace, so they are imported dynamically: a bare run then says how to run
 * this properly instead of failing with a module-not-found stack.
 */

let Context
let SessionProjectionRegistry
let explorer
try {
  ({ Context } = await import('@deepseek-ai/cordis'))
  ;({ default: SessionProjectionRegistry } = await import('@deepseek-ai/dsh-session-projection'))
  explorer = await import('dsh-context-explorer')
} catch (error) {
  const reason = error instanceof Error ? error.message.split('\n')[0] : String(error)
  console.error(`cannot resolve the installed Harness from here: ${reason}`)
  console.error('run this probe through the profile resolver instead, from the profile directory:')
  console.error('  node --import "file:///<repo>/tools/profile-resolver.mjs" <repo>/tools/activation-probe.mjs')
  process.exit(2)
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

const events = [
  { type: 'request/header', seq: 1, time: 0, data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }] } } },
  { type: 'system/message', seq: 2, time: 0, surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: 'You are an AI agent powered by DeepSeek Harness.\n\nSecond section.' }] } } },
  { type: 'user/message', seq: 3, time: 0, surfaceOp: 'append', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] } },
]

function sessionStub() {
  return {
    id: 'probe-session',
    header: { version: 4, id: 'probe-session', createdAt: 0, isSeeded: false },
    inheritedEventCount: 0,
    seq: events.length,
    snapshotEvents: () => events,
    ownEvents: () => events,
    eventAt: seq => events.find(event => event.seq === seq),
  }
}

const root = new Context()
root.plugin(SessionProjectionRegistry)
await wait(30)

// Mount exactly as the Loader does for a function plugin with `inject`.
root.plugin({ name: 'context-explorer', inject: explorer.inject, apply: explorer.apply })
await wait(80)

const snapshot = root.get('sessionProjections').snapshot(sessionStub())
const view = snapshot.values.contextExplorer

console.log('registered keys :', Object.keys(snapshot.values).join(', ') || '(none)')
if (view === undefined) {
  console.log('RESULT: the Host half did NOT register its unit')
  process.exit(1)
}
// The wire carries only what the panel draws, so this prints the fields that are
// on it rather than the ones a previous shape had.
console.log('total tokens    :', view.totalTokens)
console.log('reported prompt :', view.reportPromptTokens)
console.log('context window  :', view.contextWindow ?? '(none)')
console.log('regions         :', view.regions.length, '—', view.regions.map(region => `${region.kind}(${region.tokens}${region.measured ? ', measured' : ''})`).join(' '))
console.log('measured regions:', view.regions.filter(region => region.measured === true).length)
console.log('failure         :', view.failure)
console.log('RESULT: the Host half activates and publishes a valid view')
