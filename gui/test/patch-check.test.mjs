import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { checkPatch, splitPatch } from '../server/runtime/patch-check.mjs'

export const name = 'patch check — would a run\'s patch apply to the checkout now, across linked collections'

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { encoding: 'utf8' })

// An application checkout whose `@shared` links into a separate framework repository, like
// /projects/example-project/@system-modules -> /projects/framework/@system-modules.
async function fixture () {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'patch-check-'))
  const framework = path.join(root, 'framework')
  const app = path.join(root, 'app')
  await fs.mkdir(path.join(framework, '@shared', 'mod'), { recursive: true })
  await fs.writeFile(path.join(framework, '@shared', 'mod', 'a.mjs'), 'export const a = 1\n')
  git(root, 'init', '-q', framework)
  git(framework, 'add', '.')
  git(framework, 'commit', '-qm', 'init')
  await fs.mkdir(app)
  await fs.writeFile(path.join(app, 'app.mjs'), 'export const app = 1\n')
  await fs.symlink(path.join(framework, '@shared'), path.join(app, '@shared'))
  git(root, 'init', '-q', app)
  git(app, 'add', '.')
  git(app, 'commit', '-qm', 'init')
  return { root, framework, app }
}

const patch = `diff --git a/app.mjs b/app.mjs
--- a/app.mjs
+++ b/app.mjs
@@ -1 +1 @@
-export const app = 1
+export const app = 2
diff --git a/@shared/mod/a.mjs b/@shared/mod/a.mjs
--- a/@shared/mod/a.mjs
+++ b/@shared/mod/a.mjs
@@ -1 +1 @@
-export const a = 1
+export const a = 2
`

export default async function (t) {
  const f = await fixture()
  const patchFile = path.join(f.root, 'run.patch')
  await fs.writeFile(patchFile, patch)
  const check = () => checkPatch({ patchFile, projectPath: f.app })
  try {
    t.section('1. the patch is split per file')
    t.eq('two sections, their paths', splitPatch(patch).map((s) => s.path), ['app.mjs', '@shared/mod/a.mjs'])

    t.section('2. each file is checked in the checkout that owns it')
    const fresh = await check()
    t.eq('applies, in two owners', [fresh.state, fresh.owners.map((o) => [path.basename(o.path), o.state])], ['applies', [['app', 'applies'], ['framework', 'applies']]])
    t.eq('nothing was written', [git(f.app, 'status', '--porcelain'), git(f.framework, 'status', '--porcelain')], ['', ''])

    t.section('3. a patch already in is recognised')
    const [appPart, sharedPart] = splitPatch(patch)
    await fs.writeFile(path.join(f.root, 'app.patch'), appPart.body)
    await fs.writeFile(path.join(f.root, 'shared.patch'), sharedPart.body)
    git(f.app, 'apply', '-p1', path.join(f.root, 'app.patch'))
    git(f.framework, 'apply', '-p2', '--directory=@shared', path.join(f.root, 'shared.patch'))
    t.eq('applied everywhere', (await check()).state, 'applied')

    t.section('4. a conflicting change names the file')
    git(f.app, 'checkout', '-q', '--', '.')
    git(f.framework, 'checkout', '-q', '--', '.')
    await fs.writeFile(path.join(f.framework, '@shared', 'mod', 'a.mjs'), 'export const a = 7\n')
    const conflict = await check()
    const framework = conflict.owners.find((o) => path.basename(o.path) === 'framework')
    t.eq('conflicts in the framework only', [conflict.state, framework.state, framework.conflicts], ['conflicts', 'conflicts', ['@shared/mod/a.mjs']])
    t.eq('the application part still applies', conflict.owners.find((o) => path.basename(o.path) === 'app').state, 'applies')

    t.section('5. half applied is not "applied"')
    git(f.framework, 'checkout', '-q', '--', '.')
    git(f.app, 'apply', '-p1', path.join(f.root, 'app.patch'))
    t.eq('mixed applied and applicable is a conflict for the whole', (await check()).state, 'conflicts')

    t.section('6. a link into the MIDDLE of another checkout keeps its place there')
    git(f.app, 'checkout', '-q', '--', '.')
    await fs.symlink(path.join(f.framework, '@shared', 'mod'), path.join(f.app, 'mod'))
    const deep = path.join(f.root, 'deep.patch')
    await fs.writeFile(deep, 'diff --git a/mod/a.mjs b/mod/a.mjs\n--- a/mod/a.mjs\n+++ b/mod/a.mjs\n@@ -1 +1 @@\n-export const a = 1\n+export const a = 3\n')
    const linked = await checkPatch({ patchFile: deep, projectPath: f.app })
    t.eq('checked as @shared/mod/a.mjs in the framework', [linked.state, path.basename(linked.owners[0].path)], ['applies', 'framework'])

    t.section('7. a ß.<name>.mjs path, which git C-quotes, is followed like any other')
    await fs.writeFile(path.join(f.framework, '@shared', 'mod', 'ß.x.mjs'), 'export default 1\n')
    git(f.framework, 'add', '.')
    git(f.framework, 'commit', '-qm', 'ß')
    await fs.writeFile(path.join(f.framework, '@shared', 'mod', 'ß.x.mjs'), 'export default 2\n')
    const quotedPatch = path.join(f.root, 'quoted.patch')
    await fs.writeFile(quotedPatch, git(f.framework, 'diff', '--src-prefix=a/@shared/', '--dst-prefix=b/@shared/', '--', '@shared/mod/ß.x.mjs').replaceAll('a/@shared/@shared/', 'a/@shared/').replaceAll('b/@shared/@shared/', 'b/@shared/'))
    git(f.framework, 'checkout', '-q', '--', '.')
    t.ok('git quoted it', (await fs.readFile(quotedPatch, 'utf8')).includes('"a/@shared/mod/\\303\\237.x.mjs"'))
    const quoted = await checkPatch({ patchFile: quotedPatch, projectPath: f.app })
    t.eq('read, followed into the framework, applies', [quoted.state, path.basename(quoted.owners[0]?.path ?? '')], ['applies', 'framework'])
  } finally {
    await fs.rm(f.root, { recursive: true, force: true })
  }
}
