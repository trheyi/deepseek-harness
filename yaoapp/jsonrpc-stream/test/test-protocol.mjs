/**
 * Protocol-level test: verifies initialize handshake, plugin loading, and
 * clean exit on shutdown — no API key needed.
 */
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const configPath = resolve(__dirname, 'cordis.yml')

const child = spawn(
  'node',
  ['--import', 'tsx/esm', resolve(__dirname, '../src/bin.ts')],
  {
    env: {
      ...process.env,
      DSH_CORDIS_CONFIG: configPath,
      DSH_SESSION_ROOT: '/tmp/yaoapp-test-proto',
      DSH_CWD: __dirname,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  },
)

const responses = []
let buffer = ''

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const obj = JSON.parse(line)
      responses.push(obj)
      console.log('[RESPONSE]', JSON.stringify(obj, null, 2))
    } catch {
      console.log('[RAW]', line)
    }
  }
})

child.stderr.on('data', (chunk) => {
  const text = chunk.toString()
  console.log(`[STDERR] ${text.trimEnd()}`)
})

function send(obj) {
  const line = JSON.stringify(obj) + '\n'
  console.log('[SEND]', line.trim())
  child.stdin.write(line)
}

await new Promise(resolve => setTimeout(resolve, 3000))

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
  cwd: __dirname,
  provider: 'deepseek-official',
  model: 'deepseek-official',
}})

await new Promise(resolve => setTimeout(resolve, 2000))

const initResponse = responses.find(r => r.id === 1)
if (initResponse?.result?.serverInfo?.name === 'yaoapp-dsh-stream') {
  console.log('\n[PASS] initialize returned correct serverInfo')
} else {
  console.log('\n[FAIL] unexpected initialize response:', initResponse)
  process.exitCode = 1
}

send({ jsonrpc: '2.0', id: 99, method: 'shutdown' })

await new Promise(resolve => setTimeout(resolve, 3000))

const shutdownResponse = responses.find(r => r.id === 99)
if (shutdownResponse?.result !== undefined) {
  console.log('[PASS] shutdown returned successfully')
} else {
  console.log('[FAIL] shutdown response:', shutdownResponse)
  process.exitCode = 1
}

child.on('exit', (code) => {
  console.log(`[EXIT] code=${code}`)
  if (code === 0) {
    console.log('[PASS] process exited cleanly')
  } else {
    console.log(`[FAIL] process exited with code ${code}`)
    process.exitCode = 1
  }
})

setTimeout(() => {
  if (!child.killed) {
    console.log('[TIMEOUT] killing child')
    child.kill('SIGTERM')
    process.exitCode = 1
  }
}, 15000)
