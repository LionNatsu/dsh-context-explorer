/**
 * Static checks for the Context Explorer bundle.
 *
 * The browser half has no type check behind it and both halves ship as plain
 * ESM, so this file owns the failure modes a compiler would otherwise catch: a
 * reference whose declaration was edited away, a declaration that shadows a
 * builtin (a hoisted `function Map` broke `new Map()` for a whole factory body),
 * an import that cannot resolve from a linked profile, a class the stylesheet
 * styles under a name no element applies, and a manifest that omits a file the
 * plugin needs at runtime.
 *
 * Structural and behavioural checks live in `context-explorer.contract.mjs` and
 * `context-explorer.test.mjs`; this file is the packaging and binding layer.
 *
 * Run: node tools/check-bundle.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { BUNDLE, PROSE_ACRONYMS, BUILTINS, bindingsOf, undeclaredConstants } from './check-shared.mjs'

let failures = 0
let checks = 0

/** Assert one condition. */
function check(label, condition, detail) {
  checks += 1
  console.log(`  ${condition ? 'ok  ' : 'FAIL'} ${label}${condition || detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures += 1
}

/** Read one bundle file. */
function read(name) {
  return readFileSync(`${BUNDLE}/${name}`, 'utf8')
}

/** Every file the plugin reads at runtime, and the two dictionaries it lists with. */
const SHIPPED = ['package.json', 'cordis.patch.yml', 'index.js', 'serve.js', 'estimate.js', 'client.js', 'icon.svg', 'locale/en.json', 'locale/zh.json']

console.log('files')
{
  const missing = SHIPPED.filter(name => !existsSync(`${BUNDLE}/${name}`))
  check('every file the bundle ships is present', missing.length === 0, missing.join(', '))
  if (missing.length > 0) {
    // Every check below reads one of these, so the absence is reported once
    // instead of turning into a stack trace per check.
    console.log(`\n${checks - failures}/${checks} checks passed`)
    process.exit(1)
  }
}

const host = read('index.js')
const serve = read('serve.js')
const client = read('client.js')
const manifest = JSON.parse(read('package.json'))

console.log('\nmanifest')
{
  // `files` is what `npm pack` ships, so a runtime file missing from it makes
  // the installed bundle fail on import rather than on a check.
  const files = manifest.files ?? []
  const omitted = ['index.js', 'serve.js', 'estimate.js', 'client.js', 'cordis.patch.yml', 'icon.svg']
    .filter(name => !files.includes(name))
    .concat(files.some(entry => entry.startsWith('locale')) ? [] : ['locale'])
  check('the manifest ships every runtime file', omitted.length === 0, `missing ${omitted.join(', ')} from [${files.join(', ')}]`)

  check('both halves resolve through the manifest',
    manifest.exports?.['.'] === './index.js' && manifest.exports?.['./client'] === './client.js',
    JSON.stringify(manifest.exports))

  const patch = manifest.dsh?.bundle?.patch
  check('the declared bundle patch ships',
    typeof patch === 'string' && existsSync(`${BUNDLE}/${patch}`), String(patch))

  check('the manifest declares a web client half',
    manifest.dsh?.client?.platform === 'web', JSON.stringify(manifest.dsh?.client))
}

console.log('\nmodule bindings — browser half')
{
  const undeclared = undeclaredConstants(client, PROSE_ACRONYMS)
  check('every all-caps reference is declared', undeclared.length === 0, undeclared.join(', '))

  const clashes = [...bindingsOf(client)].filter(name => BUILTINS.includes(name))
  check('no declaration shadows a JavaScript builtin', clashes.length === 0, clashes.join(', '))

  // The stylesheet is a template literal and its rules are matched by class
  // name, so a renamed element silently loses its styling — the failure mode
  // behind the inline `min-width: 0` notes in the browser half. This compares
  // the two lists instead: every class the stylesheet styles must be applied by
  // some element. (The reverse does not hold: wrapper elements such as `gridBox`
  // carry inline styles and have no rule of their own.)
  const stylesheet = /const css = `([\s\S]*?)`/.exec(client)?.[1] ?? ''
  const styled = new Set([...stylesheet.matchAll(/\.([a-z][\w-]*)/g)].map(match => match[1]))
  // One element can apply several classes (`className: 'row chipRow'`), so each
  // value is split rather than taken whole.
  const applied = new Set([...client.matchAll(/className: '([^']+)'/g)].flatMap(match => match[1].trim().split(/\s+/)))
  const orphaned = [...styled].filter(name => !applied.has(name))
  check('every class the stylesheet styles is applied by an element',
    styled.size > 0 && applied.size > 0 && orphaned.length === 0,
    `styled=[${[...styled].join(' ')}] applied=[${[...applied].join(' ')}]`)
}

console.log('\nmodule bindings — host half')
{
  // The all-caps scan reads the projection only. `serve.js` is a prose-heavy
  // transcription of the recipe: its prompt template legitimately contains the
  // words the backend sends and placeholders such as `$TOOL_NAME`, which are
  // text, not free references. The renderer's own behaviour is owned by
  // tools/prompt-golden.mjs and by the fragment checks in the fold suite.
  const undeclared = undeclaredConstants(host, PROSE_ACRONYMS)
  check('every all-caps reference is declared', undeclared.length === 0, undeclared.join(', '))

  // The shadow scan does read both files, because it looks at declarations,
  // which a prompt string cannot fake.
  const clashes = [...bindingsOf(`${host}\n${serve}`)].filter(name => BUILTINS.includes(name) || name === 'Buffer')
  check('no declaration shadows a JavaScript builtin', clashes.length === 0, clashes.join(', '))

  // The host half runs from a linked profile directory where the Harness's own
  // packages are not visible, so every import must resolve inside the bundle —
  // and it must have the estimator import at all, since a dropped one turns
  // every price into a free reference rather than a manifest error.
  const imports = [...host.matchAll(/from\s+'([^']+)'/g)].map(match => match[1])
  const unresolved = imports.filter(specifier => !specifier.startsWith('.') || !existsSync(`${BUNDLE}/${specifier.replace('./', '')}`))
  check('the host half imports its siblings and nothing else',
    imports.length > 0 && unresolved.length === 0,
    imports.length === 0 ? 'no import at all' : unresolved.join(', '))
}

console.log('\nlocale')
{
  // The plugin listing reads these two files for its own name and description,
  // through the installed `dsh-app-boot`, which reads `meta.title` and
  // `meta.description` and rejects an empty one. A flat dictionary, or a
  // non-empty title missing, silently falls back to the package name in
  // Settings → Plugins. The panel's own copy lives inside the browser half and
  // is checked in context-explorer.contract.mjs, which owns its key coverage.
  const dictionaries = ['zh', 'en'].map(name => JSON.parse(read(`locale/${name}.json`)))
  const text = (value) => typeof value === 'string' && value.trim() !== ''
  const incomplete = dictionaries.filter(entry => !text(entry.meta?.title) || !text(entry.meta?.description))
  check('both shipped dictionaries name and describe the plugin', incomplete.length === 0,
    dictionaries.map(entry => `${entry.meta?.title ?? '?'}/${entry.meta?.description ?? '?'}`).join(', '))
}

console.log('\nicon')
{
  // The mark is drawn twice and the two copies take opposite colour rules on
  // purpose: `icon.svg` is rendered as an image in the plugin listing, where
  // there is no inherited colour and `currentColor` resolves to black — the mark
  // shipped that way once and came out as a black square — so the file must
  // carry a literal fill; the inline glyph is drawn inside the tab chip and must
  // inherit that chip's hover and active colours, so it must not.
  const svg = read('icon.svg')
  const svgFills = [...svg.matchAll(/fill="([^"]*)"/g)].map(match => match[1].trim())
  const inlineFills = [...client.matchAll(/fill: '([^']*)'/g)].map(match => match[1].trim())
  const shippedFillsItself = svgFills.length > 0 && svgFills.every(value => value !== '' && value !== 'none' && !value.includes('currentColor'))
  const inlineInherits = inlineFills.includes('currentColor')
  check('the shipped icon fills itself, the inline glyph inherits the chip colour',
    shippedFillsItself && inlineInherits,
    `icon.svg fill=[${svgFills.join(' ')}] must be literal because the file is rendered as an image;`
    + ` client.js fill: [${inlineFills.join(' ')}] must be currentColor because the glyph is drawn in the chip`)
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
