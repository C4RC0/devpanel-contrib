import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The checkout THIS suite lives in, never a fixed path: a frozen copy of the
 * tree must test its own configuration and harnesses, not whatever the live
 * checkout holds at the moment (the baseline comparison of the Gemini review was
 * contaminated exactly that way). Deliberately not the environment's
 * `DEVPANEL_CONFIG_ROOT` either: an inherited value would reopen the same leak.
 */
export const CONFIG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Directories a config sandbox needs. Never includes issues/ — tests must not touch real data. */
const CONFIG_DIRS = ['roster', 'strategy-templates', 'playbooks', 'schemas', 'harness', 'providers']

const sandboxes = []

/**
 * Copy the real configuration to a temp root and apply mutations there, so a
 * test can break a file without touching the project.
 */
export async function sandbox (mutate) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-cfg-'))
  sandboxes.push(dir)
  for (const d of CONFIG_DIRS) {
    await fs.cp(path.join(CONFIG_ROOT, d), path.join(dir, d), { recursive: true })
  }
  // fs.cp keeps the source modes; a reviewer seat's export of the checkout is
  // read-only (0444/0555), and the copy must still take a test's mutations.
  for (const entry of await fs.readdir(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath ?? entry.path, entry.name)
    await fs.chmod(file, entry.isDirectory() ? 0o755 : 0o644)
  }
  if (mutate) await mutate(dir)
  return dir
}

export async function cleanupSandboxes () {
  await Promise.all(sandboxes.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
}

/**
 * server.listen as a promise that also rejects: a refused listen is emitted as
 * 'error', which nobody else listens for, and would end the whole test run.
 */
export function listen (server, ...args) {
  return new Promise((resolve, reject) => {
    const fail = (error) => { server.close(() => reject(error)) }
    server.once('error', fail)
    try {
      server.listen(...args, () => { server.off('error', fail); resolve(server) })
    } catch (error) {
      server.off('error', fail)
      reject(error)
    }
  })
}

/** Replace an exact anchor in a file, failing loudly if the anchor has drifted. */
export async function patch (file, from, to) {
  const text = await fs.readFile(file, 'utf8')
  if (!text.includes(from)) throw new Error(`patch anchor not found in ${file}: ${JSON.stringify(from)}`)
  await fs.writeFile(file, text.replace(from, to))
}

/**
 * Occupy a seat in a sandbox playbook: `seat` is its YAML block ("  auditor-1:\n    model: x").
 * A seat the playbook already occupies (auditor-1 is occupied by default) is
 * replaced, never duplicated — two blocks for one role are invalid YAML.
 */
export const withoutSeat = (text, role) => text.replace(new RegExp(`^  ${role}:\\n(?:    .*\\n)*`, 'm'), '')
export async function occupySeat (file, seat) {
  const role = seat.match(/^  ([a-z0-9-]+):/)[1]
  const text = withoutSeat(await fs.readFile(file, 'utf8'), role)
  if (!text.includes('participants:\n')) throw new Error(`no participants in ${file}`)
  await fs.writeFile(file, text.replace('participants:\n', `participants:\n${seat.replace(/\n?$/, '\n')}`))
}

export const errorMatching = (result, re) => (result.errors ?? []).find((e) => re.test(e.message))
export const hasFinding = (result, level, status, re) =>
  result.findings.some((f) => f.level === level && f.status === status && (!re || re.test(f.message)))

/** Capabilities a healthy harness reports; override per test. */
export const capabilities = (over = {}) => ({
  sessionAssignment: 'preassign', resume: true, effort: true,
  structuredOutput: true, cancellation: true, instructions: true, ...over
})

/** An injected probe, so preflight tests never spawn anything. */
export const fakeProbe = (over = {}) => async (harness, { models = [], profile, endpointRef, credentialRef } = {}) => ({
  id: harness,
  depth: 'model',
  connection: { profile, endpointRef, credentialRef },
  capabilities: capabilities(over.capabilities),
  installation: over.installation ?? { status: 'installed', version: '1.0.0' },
  authentication: over.authentication ?? { status: 'ok' },
  modelAccess: Object.fromEntries(models.map((m) => [m, over.modelAccess ?? { status: 'ok' }]))
})

/** A resolved playbook with its roster verification forced, to isolate other checks. */
export function asVerified (resolved) {
  const clone = structuredClone(resolved)
  clone.liveExecution = { eligible: true, blockers: [] }
  return clone
}
