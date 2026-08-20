/**
 * Yao JSON-RPC stream plugin over stdio. Replaces the official
 * {@link @deepseek-ai/dsh-sdk-jsonrpc-server} with resume and auto-exit.
 *
 * Stdout is reserved for protocol frames; the tree must not load a stdout logger.
 * The plugin exits 0 on idle (after the prompted session completes) or on `shutdown`.
 * The app bin owns signal exits; this plugin does NOT exit on stdin EOF.
 *
 * @module @yaoapp/dsh-sdk-jsonrpc-stream
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Readable, Writable } from 'node:stream'
import Schema from '@deepseek-ai/schemastery'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'
import { JsonRpcStream } from './stream.ts'

export { JsonRpcStream } from './stream.ts'

export const name = 'yaoapp-jsonrpc-stream'
export const inject = ['agents']

export interface StreamConfig {
  maxTokensAsSuccess?: boolean
  input?: Readable
  output?: Writable
  exit?: (code: number) => void
}

export const Config: Schema<StreamConfig> = Schema.object({
  maxTokensAsSuccess: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: StreamConfig): void {
  const resolvedConfig = config as StreamConfig & { maxTokensAsSuccess: boolean }
  const rootFiber = ctx.root.fiber
  const input = config.input ?? process.stdin
  const output = config.output ?? process.stdout
  const exit = config.exit ?? ((code: number): void => { process.exit(code) })

  const transport = new JsonRpcLineTransport(input, output)
  const server = new JsonRpcStream(ctx, transport, {
    maxTokensAsSuccess: resolvedConfig.maxTokensAsSuccess,
  })

  let exitTask: Promise<void> | undefined
  const DISPOSE_TIMEOUT_MS = 5000
  const HARD_EXIT_MS = 10000
  const disposeAndExit = (): Promise<void> => {
    exitTask ??= (async () => {
      const hardTimer = setTimeout(() => { exit(1) }, HARD_EXIT_MS)
      hardTimer.unref()
      await Promise.allSettled([Promise.resolve().then(() => transport.flush())])
      const disposeOrTimeout = Promise.race([
        rootFiber.dispose(),
        new Promise<void>(resolve => setTimeout(resolve, DISPOSE_TIMEOUT_MS)),
      ])
      await Promise.allSettled([disposeOrTimeout])
      exit(0)
    })()
    return exitTask
  }

  server.onIdle = () => {
    setImmediate(() => { void disposeAndExit() })
  }

  transport.onRequest(async (method, params) => {
    const result = await server.handleRequest(method, params)
    if (method === 'shutdown') {
      setImmediate(() => { void disposeAndExit() })
    }
    return result
  })

  ctx.effect(() => {
    transport.start()
    return async () => {
      await server.shutdown()
      transport.close()
    }
  }, 'yaoapp-stream.serve')
}
