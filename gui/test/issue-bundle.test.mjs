import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export const name = 'archived issues are packed out of the project folder, and restored intact'

const exec = promisify(execFile)
const git = (cwd, ...args) => exec('git', ['-C', cwd, ...args]).then((r) => r.stdout.trim())
const exists = (p) => fs.access(p).then(() => true, () => false)

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-bundle-'))
  const projects = path.join(root, 'projects')
  const issuesDir = path.join(root, 'issues')
  const project = 'bundle-project'
  const repo = path.join(projects, project)
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(issuesDir)
  await git(repo, 'init', '-q')
  await git(repo, 'config', 'user.email', 't@example.invalid')
  await git(repo, 'config', 'user.name', 'test')
  await fs.writeFile(path.join(repo, 'app.txt'), 'one\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-qm', 'base')
  const base = await git(repo, 'rev-parse', 'HEAD')

  const saved = { issues: process.env.DEVPANEL_ISSUES_DIR, projects: process.env.DEVPANEL_PROJECTS_DIR }
  process.env.DEVPANEL_ISSUES_DIR = issuesDir
  process.env.DEVPANEL_PROJECTS_DIR = projects
  const issues = await import(`../server/issues.js?bundle=${Date.now()}`)
  try {
    const opened = await issues.createIssue(project, { name: 'Packed fixture' })
    const dir = path.join(issuesDir, project, opened.id)
    const runId = '2026-09-28T10-00-00-000Z-abcdef12'
    const runDir = path.join(dir, 'runs', runId)
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ at: 'x', type: 'started' }) + '\n')
    // A seat may write a file named with git's C-quoting taken literally (backslashes,
    // a stray quote); tar escapes those in its listing by default.
    await fs.mkdir(path.join(runDir, 'scratch', '"@mod'), { recursive: true })
    await fs.writeFile(path.join(runDir, 'scratch', '"@mod', '\\303\\237.file.mjs"'), '')
    // A run that stopped with work only in its worktree.
    const wt = path.join(dir, 'runs', `worktree-${runId}`)
    await git(repo, 'worktree', 'add', '-q', '--detach', wt, base)
    await fs.writeFile(path.join(wt, 'app.txt'), 'one\ntwo\n')
    await fs.writeFile(path.join(wt, 'new.txt'), 'untracked work\n')
    await fs.writeFile(path.join(runDir, 'run.json'), JSON.stringify({
      runId, status: 'blocked', outcome: 'unresolved', blockedReason: 'rounds-exhausted', playbook: { id: 'implementation', configHash: 'sha256:abc' },
      steps: [], startedAt: '2026-09-28T10:00:00.000Z', endedAt: '2026-09-28T10:05:00.000Z', participants: {},
      workspace: { path: wt, baseCommit: base, state: 'retained' }
    }))
    const before = (await exec('find', [dir, '-type', 'f', '-not', '-path', `${wt}/*`])).stdout.split('\n').filter(Boolean).length

    t.section('archiving packs the issue')
    const archived = await issues.setIssueArchived(project, opened.id, true, { overrideReason: 'test fixture' })
    t.eq('it reads as archived and packed', [archived.archived, archived.packed], [true, true])
    t.eq('the folder is gone from the project', await exists(dir), false)
    const bundle = path.join(issuesDir, '.archive', project, `${opened.id}.tar.gz`)
    t.ok('the bundle is there', await exists(bundle))
    t.eq('its copyable location is the bundle, not the folder it had', archived.location, bundle)
    const listed = (await exec('tar', ['-tzf', bundle])).stdout
    t.ok('it holds the issue', listed.includes(`${opened.id}/issue.json`))
    t.ok('and a file whose name carries backslashes and a quote', listed.includes('scratch/"@mod/\\\\303\\\\237.file.mjs"') || listed.includes('scratch/"@mod/\\303\\237.file.mjs"'))
    t.ok('but no worktree', !listed.includes(`${opened.id}/runs/worktree-`))
    t.ok('the worktree\'s own changes were saved as a patch', listed.includes(`runs/${runId}/artifacts/worktree-at-archive.patch`))
    t.ok('the worktree was handed back to git', !(await git(repo, 'worktree', 'list')).includes(wt))
    t.eq('its summary names the run and what it came to', archived.archive.results.map((r) => [r.runId, r.text.split('\n')[0]]),
      [[runId, "# Stopped: the author and reviewers didn't agree in time"]])

    t.section('a packed issue is still an issue')
    const list = await issues.listIssues(project, { archived: true })
    t.eq('the archived list names it', list.map((i) => [i.id, i.packed]), [[opened.id, true]])
    t.eq('the list gives the bundle as its location too', list[0]?.location, bundle)
    t.eq('it is not in the open list', (await issues.listIssues(project)).some((i) => i.id === opened.id), false)
    const { packedRuns } = await import('../server/issue-bundle.mjs')
    t.eq('its run records are kept for history', (await packedRuns(issuesDir, project, opened.id)).map((r) => [r.runId, r.playbook.configHash]), [[runId, 'sha256:abc']])
    let refused = null
    try { await issues.createStep(project, opened.id, { name: 'note', text: 'late' }) } catch (error) { refused = error.status }
    t.eq('it takes no new steps', refused, 409)

    t.section('restore brings it back as it was')
    const restored = await issues.setIssueArchived(project, opened.id, false)
    t.eq('it is open again', [restored.archived, Boolean(restored.packed)], [false, false])
    const after = (await exec('find', [dir, '-type', 'f'])).stdout.split('\n').filter(Boolean)
    t.eq('every file is back, plus the saved patch', after.length, before + 1)
    t.eq('the saved patch holds the tracked change', (await fs.readFile(path.join(runDir, 'artifacts', 'worktree-at-archive.patch'), 'utf8')).includes('+two'), true)
    t.ok('and the untracked file', (await fs.readFile(path.join(runDir, 'artifacts', 'worktree-at-archive.patch'), 'utf8')).includes('untracked work'))
    t.eq('the run knows its worktree is gone', JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8')).workspace.state, 'removed')
    t.eq('the bundle files are gone', await exists(bundle), false)

    t.section('delete removes a packed issue for good')
    await issues.setIssueArchived(project, opened.id, true, { overrideReason: 'again' })
    const gone = await issues.deleteIssue(project, opened.id)
    t.eq('deleted', gone.deleted, true)
    t.eq('no bundle, no summary', [await exists(bundle), await exists(bundle.replace(/\.tar\.gz$/, '.json'))], [false, false])
    let missing = null
    try { await issues.getIssue(project, opened.id) } catch (error) { missing = error.status }
    t.eq('and it is no longer found', missing, 404)
  } finally {
    for (const [key, value] of [['DEVPANEL_ISSUES_DIR', saved.issues], ['DEVPANEL_PROJECTS_DIR', saved.projects]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    await fs.rm(root, { recursive: true, force: true })
  }
}
