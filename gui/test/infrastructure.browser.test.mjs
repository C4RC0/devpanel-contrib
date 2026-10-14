import fs from 'node:fs/promises'
import path from 'node:path'
import YAML from 'yaml'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'

export default async function (t) {
  const stage = await startStage()
  let browser
  try {
    const config = { id: stage.project, infrastructure: {
      kind: 'boilerplate', orientation: 'Read App-modules/module.md before authoring.',
      staging: { id: 'stage', ssh: { hostRef: 'ssh-config:stage.invalid', workdir: '/srv' }, projectRoot: '/opt/stage', files: {} },
      deployments: [{ id: 'production', ssh: { hostRef: 'ssh-config:production.invalid', workdir: '/srv' }, projectRoot: '/opt/production', files: {} }],
      testDrive: { commands: [{ id: 'readiness', run: 'test -f ready' }], notes: 'Boot the isolated candidate, then check readiness.' }
    } }
    await fs.mkdir(path.join(stage.configRoot, 'projects'), { recursive: true })
    await fs.writeFile(path.join(stage.configRoot, `projects/${stage.project}.yaml`), YAML.stringify(config))
    t.eq('infrastructure API requires authentication', (await fetch(`${stage.origin}/api/projects/${stage.project}/infrastructure`)).status, 401)
    const response = await stage.request(`/api/projects/${stage.project}/infrastructure`)
    t.eq('infrastructure API exposes configured stage', response.body.staging.id, 'stage')
    t.eq('unknown projects are refused', (await stage.request('/api/projects/missing-project/infrastructure')).status, 404)
    browser = await openBrowser(`${stage.origin}/projects/${stage.project}`, { token: stage.token })
    await browser.until(() => browser.has('Infrastructure · stage staging'))
    await browser.clickWhen(() => browser.find('summary', 'Infrastructure'))
    t.ok('project page shows orientation', browser.has(config.infrastructure.orientation))
    t.ok('project page identifies deployment role', browser.has('Deployment · inspection only'))
    t.ok('project page explains required test drive', browser.has('Test drive: required'))
    t.ok('project page names configuration file', browser.has(`projects/${stage.project}.yaml`))
  } finally { browser?.close(); await stage.stop() }
}
