import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { homeRelative, hostInfo } from '../server/metrics.js'

export const name = 'host info — /api/info carries the configured projects and issues directories, home shown as ~'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const GUI = path.resolve(HERE, '..')

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }
  try {
    t.section('1. the home directory is shown as ~, nothing else is rewritten')
    t.eq('home itself', homeRelative('/home/u', '/home/u'), '~')
    t.eq('below home', homeRelative('/home/u/devpanel/issues', '/home/u'), '~/devpanel/issues')
    t.eq('a sibling that only shares the prefix', homeRelative('/home/user2/x', '/home/u'), '/home/user2/x')
    t.eq('outside home', homeRelative('/opt/x', '/home/u'), '/opt/x')
    t.eq('absent stays null', homeRelative(null), null)

    t.section('2. hostInfo reports both directories, each from its own setting')
    const info = hostInfo({ projectsDir: '/data/projects', issuesDir: path.join(os.homedir(), 'elsewhere', 'issues') })
    t.eq('independent roots', info.directories, { projects: '/data/projects', issues: '~/elsewhere/issues' })

    t.section('3. P2-api: as the server builds it, with DEVPANEL_PROJECTS_DIR and DEVPANEL_ISSUES_DIR set independently')
    {
      const home = await temp('devpanel-home-')
      const projects = await temp('devpanel-projects-root-')
      // Not under the projects root, and under home: the issues directory is its own setting.
      const issuesDir = path.join(home, 'elsewhere', 'issues')
      // index.js: hostInfo({ issuesDir: issues.ISSUES_DIR }).
      const script = `const { hostInfo } = await import(${JSON.stringify(pathToFileURL(path.join(GUI, 'server/metrics.js')).href)})
const issues = await import(${JSON.stringify(pathToFileURL(path.join(GUI, 'server/issues.js')).href)})
console.log(JSON.stringify(hostInfo({ issuesDir: issues.ISSUES_DIR }).directories))`
      const child = async (env) => JSON.parse((await run(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, DEVPANEL_HOST_CONFIG_DIR: process.env.DEVPANEL_HOST_CONFIG_DIR, HOME: home, ...env } })).stdout)
      t.eq('both configured directories, home as ~', await child({ DEVPANEL_PROJECTS_DIR: projects, DEVPANEL_ISSUES_DIR: issuesDir }), { projects, issues: '~/elsewhere/issues' })
      const fallback = await child({ DEVPANEL_PROJECTS_DIR: projects })
      t.eq('without DEVPANEL_ISSUES_DIR: the panel\'s own issues/, not the projects root', fallback.issues, path.join(path.resolve(GUI, '..'), 'issues'))
    }

    t.section('4. the server passes the issues directory; the front end shows the configured directories')
    {
      const index = await fs.readFile(path.join(GUI, 'server/index.js'), 'utf8')
      const calls = index.match(/hostInfo\([^)]*\)/g) ?? []
      t.ok('every hostInfo call in index.js passes issues.ISSUES_DIR', calls.length > 0 && calls.every((c) => c.includes('issuesDir: issues.ISSUES_DIR')), calls.join(' '))
      const hits = []
      for (const entry of await fs.readdir(path.join(GUI, 'src'), { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue
        const file = path.join(entry.parentPath ?? entry.path, entry.name)
        if ((await fs.readFile(file, 'utf8')).includes('/srv')) hits.push(path.relative(GUI, file))
      }
      t.eq('no /srv literal in gui/src', hits, [])
      const app = await fs.readFile(path.join(GUI, 'src/App.vue'), 'utf8')
      const view = await fs.readFile(path.join(GUI, 'src/views/ProjectIssuesView.vue'), 'utf8')
      const add = await fs.readFile(path.join(GUI, 'src/components/AddToIssue.vue'), 'utf8')
      t.ok('the re-scan label, the footer and both placeholders read host.directories', [app, view, add].every((s) => s.includes('connection.host?.directories')))
    }
  } finally {
    await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
  }
}
