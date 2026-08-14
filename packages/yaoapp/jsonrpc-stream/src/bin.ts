#!/usr/bin/env node
/**
 * Custom entry point for Yao DSH stream. Unlike the official runner, this does
 * NOT listen for `process.stdin.on('end')` — the plugin's `onIdle` callback
 * drives process exit after the agent finishes its turn.
 *
 * @module @yaoapp/dsh-sdk-jsonrpc-stream/bin
 */

import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

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
async function disposeAndExit(code: number): Promise<void> {
  if (exiting) return
  exiting = true
  try { await ctx.fiber.dispose() }
  finally { process.exit(code) }
}

process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
