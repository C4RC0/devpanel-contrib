import fs from 'node:fs/promises'
import { runProcess } from './process.mjs'
import { hostPlatform, platformFor } from './platform.mjs'

/** Free Linux mount/namespace smoke test, not a model or Claude bridge probe. */
export async function probeProjectSandbox ({ projectPath, allowedRoots = [], signal = null }, { execute = runProcess, platform = hostPlatform().id } = {}) {
  if (!platformFor(platform).bubblewrap) return { status: 'skip', message: 'Linux bubblewrap probe does not apply on this platform' }
  let scratch
  try {
    const roots = [...new Set(await Promise.all([projectPath, ...allowedRoots].map(root => fs.realpath(root))))]
    const canonical = roots[0]
    if (!(await fs.stat(canonical)).isDirectory()) throw new Error('project path is not a directory')
    scratch = await fs.mkdtemp('/tmp/dpp-')
    const timeout = AbortSignal.timeout(15000)
    const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout
    const dependency = await execute({ command: 'socat', args: ['-V'], signal: bounded, maxBuffer: 4096 })
    if (dependency.cancelled) throw new Error('sandbox dependency probe cancelled or timed out')
    if (dependency.code !== 0) throw new Error(`socat unavailable: ${dependency.stderr}`)
    const result = await execute({ command: 'bwrap', args: [
      '--die-with-parent', '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid',
      '--proc', '/proc', '--dev', '/dev',
      ...roots.flatMap(root => ['--ro-bind', root, root]),
      '--bind', scratch, scratch, '--chdir', canonical, '--', '/usr/bin/true'
    ], signal: bounded, maxBuffer: 4096 })
    if (result.cancelled || result.code !== 0) throw new Error(result.cancelled ? 'bubblewrap probe cancelled or timed out' : `bubblewrap failed: ${result.stderr.trim() || `exit ${result.code}`}`)
    return { status: 'pass', projectPath: canonical, roots, message: `Sandbox mounts and namespaces work for ${canonical}; socat is installed` }
  } catch (error) {
    return { status: signal?.aborted ? 'unknown' : 'fail', message: `Project sandbox unavailable: ${error.message}` }
  } finally {
    if (scratch) await fs.rm(scratch, { recursive: true, force: true })
  }
}
