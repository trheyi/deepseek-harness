#!/usr/bin/env node
/**
 * Custom entry point for Yao DSH stream. Unlike the official runner, this does
 * NOT listen for `process.stdin.on('end')` — the plugin's `onIdle` callback
 * drives process exit after the agent finishes its turn.
 *
 * When running as a SEA (Single Executable Application), two fallback mechanisms
 * extend module resolution beyond the bundled VFS:
 * - `NODE_PATH` (set by Go launcher) — CJS `require()` fallback for sharp native deps
 * - `registerHooks()` below — ESM `import()` fallback for Cordis plugins from DSH_PLUGINS_DIR
 *
 * @module @deepseek-ai/dsh-yaoapp-jsonrpc-stream/bin
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const pluginsDir = process.env['DSH_PLUGINS_DIR']
if (pluginsDir) {
  const req = createRequire(join(pluginsDir, 'anchor.js'))
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (err) {
        if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:')) {
          try {
            const resolved = req.resolve(specifier)
            return { url: pathToFileURL(resolved).href, shortCircuit: true }
          } catch { /* plugin not found in external dir either */ }
        }
        throw err
      }
    },
  })
}

const NAME = 'yaoapp-dsh-stream'

installFailLoud(NAME)
loadEnv(NAME)

const fromEnv = process.env['DSH_CORDIS_CONFIG']
const fromArgv = process.argv[2]
const requested = fromEnv !== undefined && fromEnv !== '' ? fromEnv
  : fromArgv !== undefined && fromArgv !== '' ? fromArgv : undefined
const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined)

if (configPath === undefined || !existsSync(configPath)) {
  process.stderr.write(
    `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>)\n`,
  )
  process.exit(1)
}

const ctx = await boot(NAME, configPath, undefined, undefined, import.meta.url)

let exiting = false
const HARD_EXIT_MS = 10000
async function disposeAndExit(code: number): Promise<void> {
  if (exiting) return
  exiting = true
  const hardTimer = setTimeout(() => { process.exit(code || 1) }, HARD_EXIT_MS)
  hardTimer.unref()
  try { await ctx.fiber.dispose() }
  finally { process.exit(code) }
}

process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
