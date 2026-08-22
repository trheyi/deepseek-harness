/**
 * JSON-RPC stream handler with session resume and idle-exit support.
 * Based on {@link @deepseek-ai/dsh-sdk-jsonrpc-server/server}, extended with:
 * - `tryResume()`: resumes a persisted session via `agents.resume()` when available
 * - `onIdle` callback: fires when the prompted root session becomes idle
 * - `promptedSessionId` tracking: prevents subagent idle from triggering premature exit
 *
 * @module @deepseek-ai/dsh-yaoapp-jsonrpc-stream/stream
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from '@deepseek-ai/dsh-sdk-protocol'
import { admitContent, type WireContentPart } from './admit-content.ts'

interface SessionRecord {
  handle: AgentHandle
}

function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** @param reason - the stop reason from the agent loop or subagent end. */
function successStatus(reason: string, maxTokensAsSuccess: boolean): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && maxTokensAsSuccess ? 'ok' : 'error'
}

export interface JsonRpcStreamOptions {
  maxTokensAsSuccess?: boolean
}

/**
 * JSON-RPC stream over a booted harness context. Extends the official server
 * with session resume from persistence and an `onIdle` callback that fires
 * when the prompted root session (not subagents) enters idle state.
 */
export class JsonRpcStream {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false
  private promptedSessionId: string | undefined

  /** Fires when the prompted root session enters idle state. */
  onIdle: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: JsonRpcStreamOptions = {},
  ) {
    const maxTokensAsSuccess = this.options.maxTokensAsSuccess === true
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
      if (status === 'idle'
        && this.promptedSessionId !== undefined
        && String(agent.session.id) === this.promptedSessionId
        && this.onIdle) {
        this.onIdle()
      }
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, maxTokensAsSuccess),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * @param params - SDK handshake: cwd, provider, model, maxTokens.
   * @returns server identity.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return { serverInfo: { name: 'yaoapp-dsh-stream', version: '0.1.0' } }
  }

  /**
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrResumeOrCreateSession(params.sessionId)
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    this.promptedSessionId = params.sessionId
    const content = await admitContent(this.ctx, params.contentBlocks as WireContentPart[], this.provider, this.model)
    const message = createUserMessage({ content, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try { this.disposers.pop()?.() }
      catch (error) { failures.push(error) /* disposer threw */ }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'stream teardown failed')
    return {}
  }

  /**
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'session/cancel':
        return this.handleCancel(params as { sessionId: string })
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown method: ${method}`)
    }
  }

  private async handleCancel(params: { sessionId: string }): Promise<{ accepted: boolean }> {
    const rec = this.sessions.get(params.sessionId)
    if (!rec) return { accepted: false }
    const agent = this.ctx.agents?.get(rec.handle.agent.id)
    if (agent) agent.cancel({ kind: 'user' }, { keepInbox: true })
    return { accepted: true }
  }

  private async getOrResumeOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('stream is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.resolveSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  /**
   * Try resume from persistence first; fall back to create.
   * @param sessionId - the wire session id string.
   */
  private async resolveSession(sessionId: string): Promise<SessionRecord> {
    const resumed = await this.tryResume(sessionId)
    if (resumed) return resumed
    return this.createSession(sessionId)
  }

  private async tryResume(sessionId: string): Promise<SessionRecord | undefined> {
    const persistence: SessionPersistence | undefined = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return undefined
    const headers = await persistence.list()
    const found = headers.find(h => String(h.id) === sessionId)
    if (!found) return undefined
    try {
      const handle = await this.ctx.agents.resume({
        resumeSessionId: SessionId(sessionId),
        agentOptions: {
          provider: this.provider,
          model: this.model,
          ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
        },
      })
      const rec: SessionRecord = { handle }
      this.sessions.set(sessionId, rec)
      return rec
    } catch (err: unknown) {
      process.stderr.write(`warn: session "${sessionId}" resume failed, creating new: ${err}\n`)
      return undefined
    }
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
