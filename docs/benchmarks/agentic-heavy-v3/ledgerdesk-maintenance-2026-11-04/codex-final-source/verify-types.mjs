import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const compiler = process.env.TYPESCRIPT_COMPILER
const args = ['--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
  '--target', 'ES2022', join(root, 'sdk-types.test.mts')]
const child = compiler
  ? spawn(process.env.NODE_EXE || process.execPath, [compiler, ...args], { cwd: root, stdio: 'inherit', windowsHide: true })
  : spawn('tsc', args, { cwd: root, stdio: 'inherit', windowsHide: true })
child.on('error', () => {
  process.stderr.write('A local TypeScript compiler is required. Set TYPESCRIPT_COMPILER to its tsc.js path or provide tsc on PATH.\n')
  process.exitCode = 1
})
try {
  const [code] = await once(child, 'exit')
  process.exitCode = code === 0 ? 0 : 1
} catch { process.exitCode = 1 }
