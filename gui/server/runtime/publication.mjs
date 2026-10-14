import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runProcess } from './process.mjs'
import { engineGitEnv, HARDENED, LOCAL_TRANSPORT } from './engine-git.mjs'

/*
 * Candidate publication and source integration for private repositories
 * (the seat-access fence's "Candidate publication" and "Source integration";
 * fence.repository: 1).
 *
 * The candidate commit C is built and verified in the run's engine Git
 * directory, whose history is the filtered snapshot S alone. Before anything
 * public moves:
 *
 *  1. transfer — C is fetched into the source repository under an
 *     engine-owned temporary ref; no public ref moves;
 *  2. translate — the reviewed delta (S..C) is applied onto the source base A
 *     in a throwaway index, giving C′ with parent A. S differs from A only by
 *     exclusions and materialization, which were never reviewed and must never
 *     reach the source; when S is A, C′ is C (`identity`). C′ is verified: the
 *     same paths change between A and C′ as between S and C, each with C's
 *     blob and mode, and C′ differs from C only where S differs from A;
 *  3. publish — one `update-ref --stdin` transaction moves
 *     `refs/devpanel/reviewed/<run>` = C, `refs/devpanel/candidates/<run>` = C′
 *     and the candidate branch = C′, each against the value journaled before
 *     the transfer. Git applies all or none. A ref already at its target is
 *     verified in the same transaction; a ref holding a third value refuses
 *     (`delivery-unverifiable`) and nothing is overwritten.
 *
 * The journal (`runs/<id>/publication.json`) makes a replay (finalize, a
 * restarted delivery) reconcile instead of repeat. A delta that cannot be
 * translated — it touches a materialized path, a path excluded from the
 * snapshot, or a path that is a symlink in A — publishes C alone (the reviewed
 * ref, and the candidate refs at C) with `translation: refused`; `commit`
 * delivery refuses such a run (`integration-translation-failed`), while
 * `apply-to-source` still applies its patch (owner routing handles the
 * materialized paths).
 */

const ZERO = '0'.repeat(40)
const NUL = String.fromCharCode(0)
const NL = String.fromCharCode(10)

async function git (gitDir, args, { input = null, env = {}, allowFail = false } = {}) {
  const result = await runProcess({ command: 'git', args: [...HARDENED, '--git-dir', gitDir, ...args], env: engineGitEnv(env), stdin: input ?? '', maxBuffer: 256 * 1024 * 1024 })
  if (result.code !== 0 && !allowFail) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim().split(NL)[0]}`)
  return result
}

const refValue = async (gitDir, ref) => (await git(gitDir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true })).stdout.trim() || ZERO
const nameStatus = async (gitDir, a, b) => (await git(gitDir, ['diff', '--name-status', '-z', '--no-renames', a, b])).stdout
const namesOf = async (gitDir, a, b) => new Set((await git(gitDir, ['diff', '--name-only', '-z', '--no-renames', a, b])).stdout.split(NUL).filter(Boolean))

const readJournal = (file) => fs.readFile(file, 'utf8').then(JSON.parse, () => null)
async function writeJournal (file, journal) {
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(journal, null, 2))
  await fs.rename(tmp, file)
}

/**
 * The reviewed delta onto the source base. Returns { commit, translation } or
 * { commit: null, translation: 'refused', reason, paths }.
 */
export async function translate ({ source, reviewed, filteredBase, sourceBase, materialized = [] }) {
  if (!sourceBase || sourceBase === filteredBase) return { commit: reviewed, translation: 'identity' }
  const touched = [...await namesOf(source, filteredBase, reviewed)]
  // Where S differs from A: exclusions and materialization. The reviewed
  // delta may not touch any of it.
  const unreviewed = await namesOf(source, sourceBase, filteredBase)
  const under = (p, roots) => roots.some((r) => p === r || p.startsWith(r + '/'))
  const refused = []
  for (const p of touched) {
    if (under(p, materialized)) refused.push({ path: p, why: 'materialized from another repository' })
    else if (unreviewed.has(p)) refused.push({ path: p, why: 'excluded from the snapshot' })
  }
  if (touched.length) {
    const { stdout } = await git(source, ['ls-tree', '-z', sourceBase, '--', ...touched])
    for (const line of stdout.split(NUL).filter(Boolean)) if (line.startsWith('120000 ')) refused.push({ path: line.split('\t')[1], why: 'a symlink in the source base' })
  }
  if (refused.length) return { commit: null, translation: 'refused', reason: `the reviewed change touches ${refused.length} path(s) that cannot be carried onto the source base (${refused.slice(0, 3).map((r) => `${r.path}: ${r.why}`).join('; ')})`, paths: refused }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-translate-'))
  // C′ takes C's own dates: a replay (finalize, a repeated delivery) must
  // rebuild the same commit id, or the journal could never recognise it.
  const date = (await git(source, ['log', '-1', '--format=%at %ct', reviewed])).stdout.trim().split(' ')
  const env = { GIT_INDEX_FILE: path.join(scratch, 'index'), GIT_AUTHOR_NAME: 'devpanel', GIT_AUTHOR_EMAIL: 'devpanel@localhost', GIT_COMMITTER_NAME: 'devpanel', GIT_COMMITTER_EMAIL: 'devpanel@localhost',
    GIT_AUTHOR_DATE: `${date[0]} +0000`, GIT_COMMITTER_DATE: `${date[1] ?? date[0]} +0000` }
  let commit
  try {
    const patch = (await git(source, ['diff', '--binary', '--full-index', '--no-renames', filteredBase, reviewed])).stdout
    await git(source, ['read-tree', sourceBase], { env })
    // An empty reviewed delta is a candidate that changed nothing: C′ is A.
    const applied = patch.length ? await git(source, ['apply', '--cached', '--binary', '--whitespace=nowarn', '-'], { env, input: patch, allowFail: true }) : { code: 0, stderr: '' }
    if (applied.code !== 0) return { commit: null, translation: 'refused', reason: `the reviewed change does not apply to the source base: ${applied.stderr.trim().split(NL)[0]}`, paths: [] }
    const tree = (await git(source, ['write-tree'], { env })).stdout.trim()
    commit = (await git(source, ['commit-tree', tree, '-p', sourceBase, '-m', `devpanel integration of ${reviewed.slice(0, 12)} onto source base ${sourceBase.slice(0, 12)}`], { env })).stdout.trim()
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
  // Verification, all required.
  const failures = []
  if (await nameStatus(source, sourceBase, commit) !== await nameStatus(source, filteredBase, reviewed)) failures.push('the changed paths differ from the reviewed change')
  const drift = [...await namesOf(source, reviewed, commit)]
  const touchedSet = new Set(touched)
  if (drift.some((p) => touchedSet.has(p))) failures.push('a changed path has different content than reviewed')
  if (drift.some((p) => !unreviewed.has(p))) failures.push('a path outside exclusions and materialization differs from the reviewed tree')
  if (failures.length) return { commit: null, translation: 'refused', reason: `integration-translation-failed: ${failures.join('; ')}`, paths: [] }
  return { commit, translation: 'applied' }
}

/**
 * Transfer, translate and publish. `repository` is the run's
 * workspace.repository (engine, source). Never throws for a refusal; returns
 * { published, repository, refs, reviewed, integration, translation, reason }.
 */
export async function publishCandidate ({ repository, runId, runDir, reviewed, filteredBase, sourceBase, branch, materialized = [] }) {
  const { source, engine } = repository
  const journalFile = path.join(runDir, 'publication.json')
  const tmpRef = `refs/devpanel/tmp/${runId}`
  const names = { reviewed: `refs/devpanel/reviewed/${runId}`, candidates: `refs/devpanel/candidates/${runId}`, branch: `refs/heads/${branch}` }

  // 1. Transfer: only the run's own engine directory is ever a fetch source.
  await git(engine, ['update-ref', 'refs/devpanel/publish', reviewed])
  const fetched = await git(source, [...LOCAL_TRANSPORT, 'fetch', '-q', '--no-tags', `file://${engine}`, `+refs/devpanel/publish:${tmpRef}`], { allowFail: true })
  if (fetched.code !== 0 || await refValue(source, tmpRef) !== reviewed) {
    return { published: false, repository: source, reason: `delivery-unverifiable: the candidate could not be transferred into the source repository (${(fetched.stderr || '').trim().split(NL)[0] || 'not found after the fetch'})` }
  }

  // 2. Translate onto the source base. A delta that cannot be translated
  // publishes the reviewed ref alone: the candidate refs and the branch never
  // point at C, whose ancestry carries the snapshot's own deletions and copies
  // (implementation audit I8).
  const translated = await translate({ source, reviewed, filteredBase, sourceBase, materialized })
  const integration = translated.commit
  const targets = integration ? { reviewed, candidates: integration, branch: integration } : { reviewed }

  // 3. Journal the expected old values before any public ref moves. A replay
  // of the same publication keeps the first journal's values; a later
  // publication of a DIFFERENT candidate for this run expects the refs where
  // this run last put them (or where it first found them), never wherever
  // they are now — a value a person moved a ref to stays a third value.
  let journal = await readJournal(journalFile)
  if (!journal || journal.reviewed !== reviewed || (journal.integration ?? null) !== (integration ?? null) || Object.keys(journal.refs).join() !== Object.keys(targets).join()) {
    const expectedOld = {}
    for (const k of Object.keys(targets)) {
      const previous = journal?.refs?.[k]
      expectedOld[k] = previous ? (journal.phase === 'published' ? previous.target : previous.expectedOld) : await refValue(source, names[k])
    }
    journal = { reviewed, integration, translation: translated.translation, phase: 'publishing', refs: Object.fromEntries(Object.keys(targets).map((k) => [k, { name: names[k], expectedOld: expectedOld[k], target: targets[k] }])) }
    await writeJournal(journalFile, journal)
  }
  const lines = ['start']
  const foreign = []
  for (const [k, r] of Object.entries(journal.refs)) {
    const now = await refValue(source, r.name)
    if (now === r.target) lines.push(`verify ${r.name} ${r.target}`)
    else if (now === r.expectedOld) lines.push(`update ${r.name} ${r.target} ${r.expectedOld}`)
    else foreign.push(`${r.name} is ${now.slice(0, 12)}, expected ${r.expectedOld.slice(0, 12)} or ${r.target.slice(0, 12)}`)
  }
  if (foreign.length) {
    journal.phase = 'refused'
    journal.reason = `delivery-unverifiable: ${foreign.join('; ')}`
    await writeJournal(journalFile, journal)
    return { published: false, repository: source, reviewed, integration, translation: translated.translation, reason: journal.reason }
  }
  lines.push('prepare', 'commit')
  const tx = await git(source, ['update-ref', '--stdin'], { input: lines.join(NL) + NL, allowFail: true })
  if (tx.code !== 0) {
    journal.phase = 'refused'
    journal.reason = `delivery-unverifiable: the publication transaction was refused (${tx.stderr.trim().split(NL)[0]})`
    await writeJournal(journalFile, journal)
    return { published: false, repository: source, reviewed, integration, translation: translated.translation, reason: journal.reason }
  }
  journal.phase = 'published'
  await writeJournal(journalFile, journal)
  await git(source, ['update-ref', '-d', tmpRef], { allowFail: true })
  return {
    published: true, repository: source, reviewed, integration, refs: Object.fromEntries(Object.keys(targets).map((k) => [k, names[k]])),
    translation: translated.translation, ...(translated.translation === 'refused' ? { reason: translated.reason, refusedPaths: translated.paths } : {})
  }
}
