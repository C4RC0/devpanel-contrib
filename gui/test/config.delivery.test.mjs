import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import YAML from 'yaml'
import { loadConfig, resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { listPlaybooks, preview } from '../server/runs-api.mjs'
import { reserveRun } from '../server/runtime/launch.mjs'
import { CONFIG_ROOT, sandbox, errorMatching } from './helpers.mjs'

export const name = 'delivery requirements — resolution entry points'
const exec = promisify(execFile)
const actions = ['none', 'worktree-diff', 'commit', 'merge']

export default async function (t) {
  const root = await sandbox()
  const original = await loadConfig({ root })
  const id = 'implementation'
  const strategyId = original.playbooks.get(id).strategy
  const file = path.join(root, 'playbooks', `${id}.yaml`)
  const strategyFile = original.strategies.get(strategyId).file

  function check (label, result, required, selected) {
    const allowed = selected === undefined || actions.indexOf(selected) >= actions.indexOf(required)
    t.eq(`${label}: success`, result.ok, allowed)
    if (allowed) {
      t.eq(`${label}: effective delivery`, result.resolved.completion.delivery.action, selected ?? required)
      t.eq(`${label}: revalidation preserved`, result.resolved.completion.delivery.revalidateBeforeDelivery, true)
      t.eq(`${label}: no errors`, result.errors, [])
    } else {
      t.eq(`${label}: no resolved configuration`, result.resolved, undefined)
      t.eq(`${label}: diagnostic`, errorMatching(result, /weakens delivery/), {
        message: `playbook weakens delivery from "${required}" to "${selected}"; a playbook may only strengthen it`,
        file, field: '/delivery/action'
      })
    }
  }

  t.section('preloaded configurations: every action pair and inheritance')
  for (const required of actions) {
    for (const selected of [undefined, ...actions]) {
      const config = structuredClone(original)
      const strategy = config.strategies.get(strategyId)
      const playbook = config.playbooks.get(id)
      strategy.completion.delivery.action = required
      if (selected === undefined) delete playbook.delivery
      else playbook.delivery = { action: selected }
      const before = structuredClone(config)
      const result = await resolvePlaybook(id, { root, config })
      check(`${required} -> ${selected ?? 'inherited'}`, result, required, selected)
      t.eq('strategy remains unchanged', strategy, before.strategies.get(strategyId))
      t.eq('playbook remains unchanged', playbook, before.playbooks.get(id))
    }
  }

  async function writeSelection (required, selected) {
    const strategy = YAML.parse(await fs.readFile(strategyFile, 'utf8'))
    strategy.completion.delivery.action = required
    await fs.writeFile(strategyFile, YAML.stringify(strategy))
    const playbook = YAML.parse(await fs.readFile(file, 'utf8'))
    if (selected === undefined) delete playbook.delivery
    else playbook.delivery = { action: selected }
    await fs.writeFile(file, YAML.stringify(playbook))
  }

  t.section('filesystem resolution: schema-permitted selections and inheritance')
  for (const required of actions) {
    for (const selected of [undefined, 'worktree-diff', 'commit']) {
      await writeSelection(required, selected)
      check(`${required} -> ${selected ?? 'inherited'}`, await resolvePlaybook(id, { root }), required, selected)
    }
  }

  t.section('preview, catalogue, reservation and command-line entry points')
  for (const selected of ['worktree-diff', 'commit', 'none']) {
    await writeSelection('commit', selected)
    const allowed = selected === 'commit'
    // none is rejected by the disk schema; worktree-diff reaches semantic validation.
    const pattern = selected === 'none' ? /allowed values/ : /weakens delivery/
    for (const [label, result] of [
      ['runtime preview', await previewRun({ playbookId: id, configRoot: root })],
      ['API preview', await preview(id, { configRoot: root })]
    ]) {
      t.eq(`${label} commit -> ${selected}`, result.ok, allowed)
      if (!allowed) t.ok(`${label} carries rejection`, Boolean(errorMatching(result, pattern)))
    }
    const listed = (await listPlaybooks({ includeDeprecated: true, root })).find((p) => p.id === id)
    if (selected === 'none') t.eq('schema-invalid playbook is not offered', listed, undefined)
    else t.eq(`catalogue commit -> ${selected}`, listed?.ok, allowed)

    // A mismatched preview hash stops valid configurations before reservation writes.
    let failure
    try {
      await reserveRun({ playbookId: id, configRoot: root, issuePath: path.join(root, 'unused-issue'), expectConfigHash: 'stale' })
    } catch (error) { failure = error }
    t.eq(`reservation commit -> ${selected}`, failure?.status, allowed ? 409 : 422)
    if (!allowed) t.ok('reservation carries rejection', Boolean(errorMatching(failure, pattern)))
    t.eq('reservation created no issue state', await fs.stat(path.join(root, 'unused-issue')).then(() => true, () => false), false)

    for (const [script, args] of [
      ['server/config/check.mjs', []],
      ['server/config/check.mjs', [id]],
      ['server/runtime/preview-cli.mjs', [id]]
    ]) {
      const result = await exec(process.execPath, [path.join(CONFIG_ROOT, 'gui', script), ...args], {
        env: { ...process.env, DEVPANEL_CONFIG_ROOT: root }
      }).then((r) => ({ ...r, code: 0 }), (e) => e)
      t.eq(`${script} ${args.join(' ')} commit -> ${selected}`, result.code, allowed ? 0 : 1)
      if (!allowed) t.ok('CLI explains rejection', pattern.test(result.stdout))
    }
  }

  t.section('delivery errors survive alongside earlier validation failures')
  const config = structuredClone(original)
  config.strategies.get(strategyId).completion.delivery.action = 'commit'
  config.playbooks.get(id).delivery = { action: 'none' }
  config.playbooks.get(id).strategyVersion = 999
  const result = await resolvePlaybook(id, { root, config, runOptions: { budgets: { maxSteps: 1 } } })
  t.eq('invalid configuration fails with run options', result.ok, false)
  t.ok('version error retained', Boolean(errorMatching(result, /pinned strategyVersion/)))
  t.ok('delivery error retained', Boolean(errorMatching(result, /weakens delivery/)))
}
