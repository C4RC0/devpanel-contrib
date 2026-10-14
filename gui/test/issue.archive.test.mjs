import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
import { patch } from './helpers.mjs'
import { acquire } from '../server/runtime/lock.mjs'

const git = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const name = 'issue archive — preserve files, exclude active runs, browse and restore'

export default async function (t) {
  const stage = await startStage()
  // Archiving packs an issue into issues/.archive/<project>/<id>.tar.gz; a file
  // is read back from there, byte for byte.
  const packed = async (id, file) => (await git('tar', ['-xOzf', path.join(stage.issuesDir, '.archive', stage.project, `${id}.tar.gz`), `${id}/${file}`], { encoding: 'buffer', maxBuffer: 1 << 26 })).stdout
  const root = `/api/projects/${stage.project}/issues`
  const issue = await stage.createIssue('Keep every file')
  const dir = path.join(stage.issuesDir, stage.project, issue.id)
  const files = {
    '000-report/response.md': Buffer.from('Original response\n'),
    'runs/saved/artifacts/change.patch': Buffer.from('patch\n'),
    'runs/worktree-saved/src/half-done.bin': Buffer.from([0, 255, 1, 128]),
    '.step-reservations.json': Buffer.from('[]\n')
  }
  for (const [file, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true })
    await fs.writeFile(path.join(dir, file), bytes)
  }
  files['issue.json'] = await fs.readFile(path.join(dir, 'issue.json'))

  t.section('authenticated archive packs every file, out of the project folder')
  const unauth = await fetch(`${stage.origin}${root}/${issue.id}/archive`, { method: 'POST' })
  t.eq('archive needs authentication', unauth.status, 401)
  const archived = await stage.request(`${root}/${issue.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test: archiving without a disposition' }) })
  t.eq('archive succeeds', archived.status, 200)
  t.eq('archive state recorded', archived.body.archived, true)
  t.ok('timestamp recorded', Boolean(archived.body.archivedAt))
  t.eq('excluded from active list', (await stage.request(root)).body.some((i) => i.id === issue.id), false)
  t.eq('listed in archive', (await stage.request(`${root}?archived=true`)).body[0].id, issue.id)
  t.eq('active count excludes archive', (await stage.request('/api/projects')).body.find((p) => p.id === stage.project).issueCount, 0)
  // An inquiry is stored as an issue but stays out of the issue lists, so the
  // count beside the project leaves it out too (else the sidebar says 2 while the list shows 1).
  const inquiryDir = path.join(path.dirname(dir), '2026-10-09-inquiry-count-check')
  await fs.mkdir(inquiryDir, { recursive: true })
  await fs.writeFile(path.join(inquiryDir, 'issue.json'), JSON.stringify({ name: 'question', kind: 'inquiry', status: 'open', inquiry: { question: 'q' } }))
  t.eq('the count leaves an inquiry out, as the list does', (await stage.request('/api/projects')).body.find((p) => p.id === stage.project).issueCount, 0)
  await fs.rm(inquiryDir, { recursive: true, force: true })
  t.eq('the folder leaves the project', await fs.access(dir).then(() => true, () => false), false)
  for (const [file, bytes] of Object.entries(files)) {
    t.ok(`${file} unchanged in the bundle`, (await packed(issue.id, file)).equals(bytes))
  }
  t.eq('detail still readable', (await stage.request(`${root}/${issue.id}`)).status, 200)
  t.eq('repeat archive is harmless', (await stage.request(`${root}/${issue.id}/archive`, { method: 'POST' })).body.archivedAt, archived.body.archivedAt)
  t.eq('manual steps refused', (await stage.request(`${root}/${issue.id}/steps`, { method: 'POST', body: JSON.stringify({ name: 'new' }) })).status, 409)
  t.eq('run start refused before probes', (await stage.request(`${root}/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })).status, 409)
  t.eq('no invocation made', await fs.readFile(stage.ledger, 'utf8').catch(() => ''), '')
  t.eq('unknown issue is not created', (await stage.request(`${root}/2026-01-01-missing/archive`, { method: 'POST' })).status, 404)

  t.section('restore and busy/recovery guards')
  t.eq('restore succeeds', (await stage.request(`${root}/${issue.id}/restore`, { method: 'POST' })).body.archived, false)
  t.eq('restored to active list', (await stage.request(root)).body.length, 1)
  const lock = await acquire(path.join(dir, '.run.lock'), { purpose: 'run', runId: 'busy' })
  try {
    t.eq('active owner prevents archive', (await stage.request(`${root}/${issue.id}/archive`, { method: 'POST' })).status, 409)
  } finally { await lock.release() }
  await fs.mkdir(path.join(dir, 'runs/interrupted'), { recursive: true })
  await fs.writeFile(path.join(dir, 'runs/interrupted/run.json'), JSON.stringify({ status: 'blocked', recovery: { required: true } }))
  t.eq('unresolved recovery prevents archive', (await stage.request(`${root}/${issue.id}/archive`, { method: 'POST' })).status, 409)

  t.section('explicit abandonment preserves interrupted work and permits closing')
  const abandonUrl = `${root}/${issue.id}/runs/interrupted/abandon`
  const recoveryFile = path.join(dir, 'runs/interrupted/run.json')
  await fs.writeFile(recoveryFile, JSON.stringify({ runId: 'interrupted', status: 'blocked', blockedReason: 'recovery-required',
    recovery: { required: true, reason: 'owner disappeared' },
    participants: { author: { state: 'recovery-required', pendingInvocation: { invocationId: 'unfinished' } } },
    workspace: { path: path.join(dir, 'runs/worktree-saved'), state: 'retained' } }))
  const held = await acquire(path.join(dir, '.run.lock'), { purpose: 'run', runId: 'interrupted' })
  try {
    t.eq('abandonment refuses a live owner', (await stage.request(abandonUrl, { method: 'POST' })).status, 409)
  } finally { await held.release() }
  t.eq('abandonment requires authentication', (await fetch(`${stage.origin}${abandonUrl}`, { method: 'POST' })).status, 401)
  t.eq('operator can abandon interrupted execution', (await stage.request(abandonUrl, { method: 'POST' })).status, 200)
  const abandoned = JSON.parse(await fs.readFile(recoveryFile, 'utf8'))
  t.eq('abandoned execution is cancelled', abandoned.status, 'cancelled')
  t.ok('end time recorded', Boolean(abandoned.endedAt))
  t.eq('original pending invocation retained in audit', abandoned.abandonment.participants.author.pendingInvocation.invocationId, 'unfinished')
  t.eq('original recovery retained in audit', abandoned.abandonment.recovery.reason, 'owner disappeared')
  t.eq('pending invocation no longer blocks', abandoned.participants.author.pendingInvocation, null)
  t.eq('abandonment is idempotent', (await stage.request(abandonUrl, { method: 'POST' })).status, 200)
  t.eq('issue stays open after abandonment', (await stage.request(`${root}/${issue.id}`)).body.archived, false)
  t.eq('can close after abandonment without a reason', (await stage.request(`${root}/${issue.id}/archive`, { method: 'POST' })).status, 200)
  // Not a checkout any run can save as a patch, so it travels in the bundle as it is.
  t.ok('workspace preserved', (await packed(issue.id, 'runs/worktree-saved/src/half-done.bin')).equals(files['runs/worktree-saved/src/half-done.bin']))
  await stage.request(`${root}/${issue.id}/restore`, { method: 'POST' })

  t.section('delete is permanent, and only reachable through the archive')
  {
    await patch(path.join(stage.configRoot, 'playbooks/implementation.yaml'),
      'minimumVerification: review-only', 'minimumVerification: verified')
    const doomed = await stage.createIssue('Delete me for good')
    const dir = path.join(stage.issuesDir, stage.project, doomed.id)
    const projectPath = path.join(stage.projectsDir, stage.project)

    // A run that produced a candidate and never delivered it, so the issue holds
    // a retained worktree — registered in the HOST project's repository.
    await stage.setControl({
      delayMs: 0,
      writes: { implement: { file: 'src/kept.txt', text: 'undelivered work' } }
    })
    await stage.request(`${root}/${doomed.id}/runs`, {
      method: 'POST', body: JSON.stringify({ playbook: 'implementation' })
    })
    const settled = await (async () => {
      const deadline = Date.now() + 40000
      for (;;) {
        const [run] = await stage.runs(doomed.id)
        if (run && !['preflighting', 'pending', 'running', 'stopping'].includes(run.status)) return run
        if (Date.now() > deadline) throw new Error('the run never settled')
        await sleep(150)
      }
    })()
    t.eq('the run blocked with work still in the workspace', settled.status, 'blocked')

    const registered = async () => (await git('git', ['-C', projectPath, 'worktree', 'list', '--porcelain']))
      .stdout.split(String.fromCharCode(10))
      .filter((l) => l.startsWith('worktree ') && l.includes(doomed.id)).length
    // A private repository (fence.repository: 1) is registered nowhere: the
    // worktree is inside the issue and names its own worker Git directory.
    const runsDir = path.join(dir, 'runs')
    const wtName = (await fs.readdir(runsDir)).find((n) => n.startsWith('worktree-'))
    const entry = wtName ? await fs.readFile(path.join(runsDir, wtName, '.git'), 'utf8').catch(() => '') : ''
    const privateRepo = entry.includes(path.join(runsDir, '')) && entry.includes('/git/worker')
    t.ok('the issue holds the retained worktree', Boolean(wtName))
    t.eq('the project registers it only when it is a linked worktree', await registered(), privateRepo ? 0 : 1)

    const unauth = await fetch(`${stage.origin}${root}/${doomed.id}`, { method: 'DELETE' })
    t.eq('delete needs authentication', unauth.status, 401)

    const early = await stage.request(`${root}/${doomed.id}`, { method: 'DELETE' })
    t.eq('an active issue cannot be deleted', early.status, 409)
    t.ok('and is told to archive first', /archive/i.test(early.body.error), early.body.error)
    t.ok('so nothing was removed', await fs.access(dir).then(() => true, () => false))

    await stage.request(`${root}/${doomed.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test: archiving without a disposition' }) })
    const removed = await stage.request(`${root}/${doomed.id}`, { method: 'DELETE' })
    t.eq('an archived issue can be deleted', removed.status, 200)
    t.eq('and says so', removed.body.deleted, true)

    t.eq('the tree is gone from disk', await fs.access(dir).then(() => true, () => false), false)
    t.eq('it is out of the archive list', (await stage.request(`${root}?archived=true`)).body.length, 0)
    t.eq('and reading it now is a 404', (await stage.request(`${root}/${doomed.id}`)).status, 404)
    t.eq('deleting it again is a 404', (await stage.request(`${root}/${doomed.id}`, { method: 'DELETE' })).status, 404)

    // The part a plain rm -rf gets wrong: the host repository keeps a record of
    // every worktree, and a deleted directory leaves that record dangling.
    t.eq('the project no longer lists a worktree there', await registered(), 0)
    const porcelain = (await git('git', ['-C', projectPath, 'worktree', 'list', '--porcelain'])).stdout
    t.ok('and nothing is left prunable in it', !porcelain.includes('prunable'), porcelain.trim().slice(0, 120))

    // Deleting one issue must not disturb another.
    t.eq('other issues are untouched', (await stage.request(root)).body.length, 1)
  }

  t.section('UI archives, browses and restores')
  const other = await stage.createIssue('Archive from panel')
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${other.id}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Archive from panel'))
    // Re-query the issue action after each dialog transition.
    const archiveAction = () => browser.all('button').find((el) => el.getAttribute('aria-label') === 'Close issue')
    t.ok('close action visible', Boolean(archiveAction()))
    t.eq('header action is labelled Close', archiveAction()?.textContent.trim(), 'Close')
    t.eq('Close is next to Run a playbook', archiveAction()?.previousElementSibling?.getAttribute('aria-label'), 'Run a playbook')
    t.ok('Close belongs to the issue header', Boolean(archiveAction()?.closest('.issue__head')))
    t.eq('issue actions do not occupy the application bar', browser.all('#appbar-actions button').length, 0)
    t.eq('reload belongs to the issue header', browser.all('.issue__head button[aria-label="Reload"]').length, 1)
    await browser.clickWhen(archiveAction, { label: 'the archive action' })
    // Without a disposition, closing offers to record a reason; the reason is
    // optional and Close issue is enabled regardless.
    await browser.until(() => browser.has('Close without a disposition?'), { label: 'the reason dialog' })
    t.ok('closing without a disposition offers a reason', browser.has('Close without a disposition?'))
    const dialogClose = () => browser.all('button').find((el) => el.textContent.trim() === 'Close issue')
    t.ok('Close issue is enabled without a reason', dialogClose() && !dialogClose().disabled)
    await browser.clickWhen(() => browser.all('button').find((el) => el.textContent.trim() === 'Close issue' && !el.disabled), { label: 'the dialog\'s Close issue' })
    // The URL changes before the page it names has rendered, so waiting on the
    // pathname and then reaching for a button is a coin toss.
    await browser.until(() => browser.window.location.pathname === `/projects/${stage.project}`)
    const closed = (await stage.request(`${root}/${other.id}`)).body
    t.eq('Close archives without a reason', closed.archived, true)
    t.eq('no reason is recorded', closed.archiveOverride?.reason, null)
    await browser.clickWhen(() => browser.find('button', 'Archived issues'), { label: 'the archived tab' })

    await browser.until(() => browser.has('Archive from panel'))
    t.ok('archived issue is browsable', browser.has('Archive from panel'))
    await browser.clickWhen(
      () => browser.all('tr').find((el) => el.textContent.includes('Archive from panel')),
      { label: 'the archived issue row' })

    await browser.until(() => browser.has('Archived issue.'))
    t.ok('archive detail offers no run start', !browser.find('button', 'Run a playbook'))
    await browser.clickWhen(() => browser.find('button', 'Restore issue'), { label: 'Restore issue' })
    await browser.until(() => browser.has('Run a playbook'))
    t.eq('UI restores the issue', (await stage.request(`${root}/${other.id}`)).body.archived, false)

    // ---- delete, from the archived list and nowhere else --------------------
    await browser.goto(`/projects/${stage.project}`)
    await browser.until(() => browser.has('Archive from panel'), { label: 'the active list' })
    t.eq('the active list offers no delete', browser.all('button')
      .filter((el) => (el.getAttribute('aria-label') ?? '').startsWith('Delete')).length, 0)

    await stage.request(`${root}/${other.id}/archive`, { method: 'POST', body: JSON.stringify({ overrideReason: 'test: archiving without a disposition' }) })
    await browser.goto(`/projects/${stage.project}?archived=true`)
    await browser.until(() => browser.has('Archive from panel'), { label: 'the archived list' })

    const deleteAction = () => browser.all('button')
      .find((el) => (el.getAttribute('aria-label') ?? '') === `Delete ${other.name}`)
    t.ok('the archived list offers delete', Boolean(deleteAction()))
    t.ok('and says it cannot be undone', /cannot be undone/.test(deleteAction()?.getAttribute('title') ?? ''),
      deleteAction()?.getAttribute('title'))

    // No confirmation: archiving was the deliberate step, and this acts on the click.
    await browser.clickWhen(deleteAction, { label: 'the delete action' })

    await browser.until(() => !browser.has('Archive from panel'), { label: 'the row to go', timeout: 15000 })
    t.ok('the issue leaves the list at once', !browser.has('Archive from panel'))
    t.eq('and is gone from the server', (await stage.request(`${root}/${other.id}`)).status, 404)
    t.ok('with nothing left to click', !deleteAction())
  } finally { browser.close() }
}
