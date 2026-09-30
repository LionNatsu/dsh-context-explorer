/**
 * Helpers shared by the bundle checks.
 *
 * Kept separate so importing them never runs a check suite: `check-bundle.mjs`
 * executes its checks at module scope and ends with `process.exit`, so a file
 * that merely wants one of its constants cannot import it.
 */

import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the plugin bundle lives: the package root, which is the repository root
 * and the sibling of this `tools` directory.
 *
 * Resolved from this file rather than from the working directory, so a copy of
 * the repository tests its own package. That is what lets a mutation run happen
 * in a scratch tree instead of editing the shipped one.
 */
export const BUNDLE = dirname(fileURLToPath(new URL('.', import.meta.url)))

/**
 * All-caps words that appear only in prose, so an undeclared one is not a bug.
 *
 * Two suites used to check for undeclared constants and each kept its own copy
 * of this list; the copies drifted and each rejected a different comment. The
 * check itself is what keeps this list honest: add a word here only when it
 * names a comment, never to silence a name the code should have declared.
 */
export const PROSE_ACRONYMS = new Set([
  'CJK', 'CSS', 'DOM', 'DSH', 'JSON', 'UTF',
])

/**
 * Identifiers a JavaScript source declares or binds.
 *
 * Covers declarations, destructured parameters, imports, and loop or catch
 * bindings, which is enough to tell a free reference from a bound one.
 * @param source - the file's text.
 * @returns the set of bound names.
 */
export function bindingsOf(source) {
  const names = new Set()
  for (const match of source.matchAll(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  // Destructured parameters and bindings, e.g. `function Item({ region, total })`.
  for (const match of source.matchAll(/(?:function\s+[A-Za-z_$][\w$]*)?\s*\(\s*\{([^}]*)\}/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/[=:]/)[0].replace(/[{}\s.[\]]/g, '')
      if (name.length > 0 && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const match of source.matchAll(/import\s*\{([^}]*)\}/g)) {
    for (const piece of match[1].split(',')) {
      const name = piece.trim().split(/\s+as\s+/).pop()
      if (name !== undefined && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  for (const match of source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(match[1])
  for (const match of source.matchAll(/\b(?:for|catch)\s*\(?\s*(?:const|let|var)?\s*([A-Za-z_$][\w$]*)/g)) names.add(match[1])
  return names
}

/**
 * All-caps identifiers used but never declared.
 *
 * A name reached through a dot is a property read, not a free reference:
 * `MARKERS.BOS` needs no declaration of its own, and reporting it would demand
 * a prose-acronym entry for a name the library does declare.
 * @param source - the file's text.
 * @param prose - acronyms that occur only in text.
 * @returns the undeclared names.
 */
export function undeclaredConstants(source, prose) {
  const declared = bindingsOf(source)
  const used = new Set([...source.matchAll(/(?<!\.)\b([A-Z][A-Z0-9_]{2,})\b/g)].map(match => match[1]))
  return [...used].filter(name => !declared.has(name) && !prose.has(name))
}

/**
 * The browser half's pure helpers, loaded the way the browser loads it.
 *
 * The module registers itself with `window.__ModuleLoader__` and builds its
 * components inside the factory, so this is the only way to reach `__test`
 * without a rendered tree — and doing it in one place means the suites that
 * need those helpers cannot drift apart in how they load them.
 * @returns the module's `__test` exports.
 */
export function loadClientHelpers() {
  const source = readFileSync(`${BUNDLE}/client.js`, 'utf8')
  let registration
  new Function('window', `${source}\nreturn undefined`)({
    __ModuleLoader__: { load(entry) { registration = entry } },
  })
  if (registration === undefined) throw new Error('the browser half registered no module')
  return registration.factory((name) => {
    if (name === 'react') {
      // The factory constructs its components as it runs — it memoizes a leaf
      // and subclasses `Component` for the error boundary — so both must exist
      // even though nothing is rendered here.
      return {
        createElement: () => null,
        Fragment: Symbol('Fragment'),
        memo: (component) => component,
        Component: class {},
      }
    }
    throw new Error(`unexpected require(${JSON.stringify(name)})`)
  }).__test
}

/** Builtins a hoisted declaration must not shadow. */
export const BUILTINS = [
  'Map', 'Set', 'Date', 'Promise', 'Array', 'Object', 'Number', 'String',
  'Boolean', 'Symbol', 'Error', 'RegExp', 'Function', 'WeakMap', 'WeakSet',
  'JSON', 'Math', 'Reflect', 'Proxy',
]
