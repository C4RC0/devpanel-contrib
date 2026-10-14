import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { capabilities as codexCapabilities } from '../../harness/codex.mjs'
import { preflight } from '../server/config/preflight.mjs'
import { CONFIG_ROOT, fakeProbe, asVerified, hasFinding } from './helpers.mjs'

export const name = 'preflight — positive evidence, per connection, offline'

export default async function (t) {
  const { resolved } = await resolvePlaybook('implementation', { root: CONFIG_ROOT })
  const verified = asVerified(resolved)

  t.section('a healthy, fully probed connection is launch-ready')
  let r = await preflight(verified, { probe: fakeProbe() })
  t.ok('launchReady', r.launchReady, r.failures.concat(r.unknowns).map((f) => f.message).join('; '))
  t.ok('config passes', hasFinding(r, 'config', 'pass'))
  t.ok('installation passes', hasFinding(r, 'installation', 'pass'))

  t.section('installed is not authenticated is not model access')
  r = await preflight(verified, { probe: fakeProbe({ authentication: { status: 'missing', detail: 'no credentials' } }) })
  t.ok('unauthenticated fails', !r.launchReady && hasFinding(r, 'authentication', 'fail'))
  r = await preflight(verified, { probe: fakeProbe({ modelAccess: { status: 'denied', detail: 'not entitled' } }) })
  t.ok('model denied fails', !r.launchReady && hasFinding(r, 'modelAccess', 'fail'))

  t.section('missing runtime')
  r = await preflight(verified, { probe: fakeProbe({ installation: { status: 'missing' } }) })
  t.ok('missing binary fails', !r.launchReady && hasFinding(r, 'installation', 'fail'))
  t.ok('deeper levels not claimed to pass', !hasFinding(r, 'authentication', 'pass'))

  t.section('capabilities the playbook depends on')
  r = await preflight(verified, { probe: fakeProbe({ capabilities: { effort: false } }) })
  t.ok('effort unsupported by the runtime fails', !r.launchReady && hasFinding(r, 'capabilities', 'fail', /does not support effort/))
  r = await preflight(verified, { probe: fakeProbe({ capabilities: { resume: false } }) })
  t.ok('no session resume fails', !r.launchReady && hasFinding(r, 'capabilities', 'fail', /resume/))
  r = await preflight(verified, { probe: fakeProbe({ capabilities: { structuredOutput: false } }) })
  t.ok('no structured output warns but stays launch-ready', r.launchReady && hasFinding(r, 'capabilities', 'warn'))

  t.section('checks policy is never rewritten by availability')
  const required = structuredClone(verified)
  required.checks = { requirement: 'required', target: null, boundToRevision: true }
  r = await preflight(required, { probe: fakeProbe() })
  t.ok('required with no target fails', !r.launchReady && hasFinding(r, 'checks', 'fail', /can never be satisfied/))
  t.ok('not silently downgraded', !hasFinding(r, 'checks', 'pass'))

  t.section('authority reported separately from evidence')
  const strict = structuredClone(verified)
  strict.autoClose.minimumVerification = 'verified'
  r = await preflight(strict, { probe: fakeProbe() })
  t.ok('warns agreement alone will not close', hasFinding(r, 'checks', 'warn', /stop, unresolved, for a human/))
  r = await preflight(verified, { probe: fakeProbe() })
  t.ok('review-only playbook carries no such warning', !hasFinding(r, 'checks', 'warn', /stop, unresolved/))

  t.section('GPT roster selections resolve and pass the real Codex capability gate')
  const config = await loadConfig({ root: CONFIG_ROOT })
  for (const model of config.roster.values()) {
    if (model.harness !== 'codex' || !model.id.startsWith('gpt-')) continue
    t.ok(`${model.id} offers effort choices`, model.efforts?.length > 0)
    for (const effort of model.efforts ?? []) {
      const selection = await resolvePlaybook('implementation', {
        root: CONFIG_ROOT, config,
        runOptions: { participants: { 'auditor-1': { model: model.id, effort } } }
      })
      t.ok(`${model.id}/${effort} resolves`, selection.ok, JSON.stringify(selection.errors ?? []))
      if (!selection.ok) continue
      const checked = await preflight(asVerified(selection.resolved), {
        probe: fakeProbe({ capabilities: codexCapabilities })
      })
      t.ok(`${model.id}/${effort} passes preflight`, checked.launchReady,
        checked.failures.concat(checked.unknowns).map(f => f.message).join('; '))
    }
  }

  t.section('real adapters, installation depth, no live call')
  for (const h of ['claude', 'codex']) {
    const { probe } = await import(`${CONFIG_ROOT}/harness/${h}.mjs`)
    const res = await probe({ depth: 'installation', models: ['x'] })
    t.ok(`${h}: installed`, res.installation.status === 'installed', res.installation.version ?? res.installation.detail)
    t.eq(`${h}: authentication not assumed`, res.authentication.status, 'unknown')
    t.eq(`${h}: model access not assumed`, res.modelAccess.x.status, 'unknown')
  }
}
