import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export default async (t) => {
  t.section('a dangling project symlink is skipped, not a failed listing')

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-projects-'))
  const saved = { projects: process.env.DEVPANEL_PROJECTS_DIR, issues: process.env.DEVPANEL_ISSUES_DIR }
  try {
    const projects = path.join(root, 'srv')
    await fs.mkdir(path.join(projects, 'real-project'), { recursive: true })
    await fs.mkdir(path.join(projects, 'linked'))
    await fs.symlink('linked', path.join(projects, 'linked-project'))
    await fs.symlink('gone', path.join(projects, 'dangling-project'))
    await fs.writeFile(path.join(projects, 'file-target'), '')
    await fs.symlink('file-target', path.join(projects, 'file-project'))
    await fs.mkdir(path.join(root, 'issues'))

    process.env.DEVPANEL_PROJECTS_DIR = projects
    process.env.DEVPANEL_ISSUES_DIR = path.join(root, 'issues')
    const issues = await import(`../server/issues.js?project-list=${Date.now()}`)

    const listed = await issues.listProjects()
    t.eq('only projects that resolve to a directory are listed',
      listed.map((p) => p.id), ['linked-project', 'real-project'])
    t.eq('a linked project reports its canonical path',
      listed.find((p) => p.id === 'linked-project').path, await fs.realpath(path.join(projects, 'linked')))

    let refused = null
    try { await issues.requireProject('dangling-project') } catch (err) { refused = err.status }
    t.eq('a dangling project is unknown (404), not an internal error', refused, 404)
  } finally {
    for (const [key, value] of [['DEVPANEL_PROJECTS_DIR', saved.projects], ['DEVPANEL_ISSUES_DIR', saved.issues]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}
