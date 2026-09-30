/**
 * Probe-only Node loader: mimic the Harness profile resolver by making the
 * profile's `node_modules` visible to modules that live outside it (the
 * workspace bundle directory), so a plain `node` process can import the Host
 * half exactly as the Harness does at runtime.
 *
 * `--import` alone only evaluates this module, so the hook functions are
 * registered explicitly through `module.register`.
 *
 * This file is a diagnostic tool, not part of the installed plugin.
 */
import { createRequire, register } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The profile directory whose `node_modules` should be visible.
 *
 * A Harness shell exports `DSH_PROFILE_DIR` and `DSH_PROFILE`; outside one, the
 * default layout under the user's home is the only thing to go on. Nothing here
 * names a particular user, so the tool works on any machine.
 */
function profileDir() {
  if (process.env.DSH_PROFILE_DIR) return process.env.DSH_PROFILE_DIR
  return join(homedir(), '.dsh', 'profiles', process.env.DSH_PROFILE ?? 'web')
}

const profileRequire = createRequire(join(profileDir(), 'package.json'))

/** Esm resolve hook: fall back to the profile's resolver for bare specifiers. */
export async function resolve(specifier, context, nextResolve) {
  const passthrough = specifier.startsWith('.') || specifier.startsWith('file:') || specifier.startsWith('node:')
  if (passthrough) return nextResolve(specifier, context)
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' && error?.code !== 'MODULE_NOT_FOUND') throw error
    const resolved = profileRequire.resolve(specifier)
    return { url: `file:///${resolved.replace(/\\/g, '/')}`, shortCircuit: true }
  }
}

register(import.meta.url)
