/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-yaoapp-jsonrpc-stream`.
 * @module @deepseek-ai/dsh-yaoapp-jsonrpc-stream/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-yaoapp-jsonrpc-stream'

/** Cordis companion plugin name. */
export const name = 'yaoapp-jsonrpc-stream-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this plugin is a thin JSON-RPC transport for the Yao platform;
 * session lifecycle and tool-call relational integrity are owned by dsh-session/invariant.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
