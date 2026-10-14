import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

import { projectsRoot, projectPath, isProjectName, projectLabel, PROJECT_SUFFIX, resolveProjectPath } from '../server/project-path.mjs'
import { knownProjectRoots } from '../server/runtime/selection.mjs'
import { hostSettings } from '../server/config/host-settings.mjs'
import { applyFence, defaultCanaries } from '../../harness/fence.mjs'

export const name = 'the projects root and the -project naming rule, defined once (project-path.mjs)'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const run = promisify(execFile)
const KEYS = ['DEVPANEL_PROJECTS_DIR', 'DEVPANEL_ISSUES_DIR']

export default async (t) => {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const restore = () => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] } }
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-projects-root-'))
  try {
    // A projects root outside /srv: two projects, one of them a repository, and
    // two entries that only look like projects.
    const root = path.join(fixture, 'projects')
    await fs.mkdir(path.join(root, 'own-project'), { recursive: true })
    await fs.mkdir(path.join(root, 'other-project'))
    await fs.mkdir(path.join(root, 'notes'))
    await fs.writeFile(path.join(root, 'file-project'), '')
    await run('git', ['init', '-q', path.join(root, 'own-project')])
    const issuesDir = path.join(fixture, 'issues')
    await fs.mkdir(issuesDir)

    t.section('1. unset, the root is the host settings\' projectsRoot, else the directory holding the checkout')
    delete process.env.DEVPANEL_PROJECTS_DIR
    // The runner points DEVPANEL_HOST_CONFIG_DIR at an empty directory: no settings.
    const checkoutParent = path.resolve(HERE, '..', '..', '..')
    t.eq('the default root', projectsRoot(), checkoutParent)
    t.eq('a project path under it', projectPath('x-project'), path.join(checkoutParent, 'x-project'))
    const hostDir = path.join(fixture, 'host-config')
    await fs.mkdir(hostDir)
    await fs.writeFile(path.join(hostDir, 'settings.json'), JSON.stringify({ projectsRoot: root }))
    t.eq('the host settings name another', hostSettings({ hostDir }).projectsRoot, root)
    process.env.DEVPANEL_PROJECTS_DIR = issuesDir
    t.eq('and DEVPANEL_PROJECTS_DIR wins over both', projectsRoot(), issuesDir)
    delete process.env.DEVPANEL_PROJECTS_DIR

    t.section('2. the naming rule')
    t.eq('the suffix', PROJECT_SUFFIX, '-project')
    t.ok('a project name', isProjectName('example.invalid-project'))
    t.ok('a name without the suffix is not one', !isProjectName('notes') && !isProjectName('project'))
    t.eq('the label drops the suffix', projectLabel('example.invalid-project'), 'example.invalid')

    t.section('3. a fixture root: read on each call, discovery and paths stay inside it')
    process.env.DEVPANEL_PROJECTS_DIR = root
    t.eq('the configured root', projectsRoot(), root)
    t.eq('a project path under it', projectPath('own-project'), path.join(root, 'own-project'))
    t.eq('a project resolves inside it', await resolveProjectPath('other-project'), await fs.realpath(path.join(root, 'other-project')))
    const known = await knownProjectRoots()
    t.eq('the known repositories come from the configured root', [...known], [await fs.realpath(path.join(root, 'own-project'))])

    process.env.DEVPANEL_ISSUES_DIR = issuesDir
    const issues = await import(`../server/issues.js?projects-root=${Date.now()}`)
    const listed = await issues.listProjects()
    t.eq('the issue store lists the fixture projects', listed.map((p) => p.id), ['other-project', 'own-project'])
    t.eq('labelled by the naming rule', listed.map((p) => p.label), ['other', 'own'])

    t.section('4. the issues directory is its own setting, never derived from the projects root')
    t.eq('DEVPANEL_ISSUES_DIR is used as given', issues.ISSUES_DIR, issuesDir)
    delete process.env.DEVPANEL_ISSUES_DIR
    const defaulted = await import(`../server/issues.js?projects-root-default=${Date.now()}`)
    t.eq('unset, it is the repository issues/ whatever the projects root', defaulted.ISSUES_DIR, path.resolve(HERE, '..', '..', 'issues'))

    t.section('5. fence canaries come from the configured root, not /srv')
    const home = path.join(fixture, 'home')
    await fs.mkdir(home)
    const own = path.join(root, 'own-project')
    const canaries = await defaultCanaries({ home, granted: [own] })
    t.ok('another project under the configured root is a canary', canaries.includes(path.join(root, 'other-project')), canaries.join(','))
    t.ok('the granted project is not', !canaries.includes(own))
    // Exact, so it holds wherever the temp directory lies (even under /srv) and
    // fails if the /srv fallback contributes anything: the fixture home is empty.
    t.eq('the canaries are exactly the configured root\'s other entries, nothing from the /srv fallback',
      [...canaries].sort(), ['file-project', 'notes', 'other-project'].map((n) => path.join(root, n)))
    const empty = path.join(fixture, 'empty')
    await fs.mkdir(empty)
    t.eq('an explicit projectsDir still wins', await defaultCanaries({ home, granted: [own], projectsDir: empty }), [])

    // applyFence itself: the canaries are only observable through a proved fence.
    // Every entry of the root that is not granted counts: other-project, notes, file-project.
    const fenced = async (dir) => { process.env.DEVPANEL_PROJECTS_DIR = dir; return applyFence({ spec: { cwd: own, writable: [own] }, manifest: {} }) }
    const withOthers = await fenced(root)
    const withoutOthers = await fenced(empty)
    if (!withOthers.applied || !withoutOthers.applied) t.skip('applyFence proves the configured root\'s other projects absent', withOthers.reason ?? withoutOthers.reason)
    else t.eq('applyFence proves the configured root\'s other projects absent', withOthers.proof.canaries - withoutOthers.proof.canaries, 3)
  } finally {
    restore()
    await fs.rm(fixture, { recursive: true, force: true })
  }
}
