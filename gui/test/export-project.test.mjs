import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { exportProject } from '../server/runtime/selection.mjs'

const exec = promisify(execFile)
const git = (dir, ...args) => exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])

export const name = 'related export — never writes through a link into its target'

// An application's shape: the index tracks copies under @boilerplate/, the working tree
// replaces that directory with a symlink into the framework checkout. Exporting
// the link and then its tracked children used to chmod the live framework 0444.
export default async function (t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-export-')))
  try {
    const live = path.join(dir, 'live', 'lib')
    const app = path.join(dir, 'app')
    await fs.mkdir(live, { recursive: true })
    await fs.writeFile(path.join(live, 'a.txt'), 'framework')
    await fs.mkdir(path.join(app, 'lib'), { recursive: true })
    await fs.writeFile(path.join(app, 'lib', 'a.txt'), 'framework')
    await fs.writeFile(path.join(app, 'own.txt'), 'application')
    await git(app, 'init', '-q')
    await git(app, 'add', '-A')
    await git(app, 'commit', '-qm', 'tracked copies')
    await fs.rm(path.join(app, 'lib'), { recursive: true })
    await fs.symlink(live, path.join(app, 'lib'))

    const before = (await fs.stat(path.join(live, 'a.txt'))).mode
    const result = await exportProject({ projectPath: app, target: path.join(dir, 'out') })
    t.eq('the link target keeps its mode', (await fs.stat(path.join(live, 'a.txt'))).mode, before)
    t.eq('the tracked path beyond the link is counted, not exported', result.beyondLinks, 1)
    t.eq('the project\'s own file is exported', result.files, 1)
    t.ok('the link itself is kept as a link', (await fs.lstat(path.join(dir, 'out', 'lib'))).isSymbolicLink())
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}
