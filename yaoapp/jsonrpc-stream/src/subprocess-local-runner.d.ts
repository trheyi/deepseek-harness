/**
 * Module declaration for the subprocess-local runner subpath export.
 * Needed because this plugin is outside the pnpm workspace and lacks the
 * node_modules symlink that normally resolves subpath exports. The runner
 * import is dynamic (SEA subprocess re-exec mode only).
 */
declare module '@deepseek-ai/dsh-subprocess-local/runner' {
  export function runSelectedSubprocessRunner(selection: string): Promise<void>
}
