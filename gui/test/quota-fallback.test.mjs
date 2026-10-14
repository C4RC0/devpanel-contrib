import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { fallbackCandidates, createQuotaFallback } from '../server/runtime/model-fallback.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { CONFIG_ROOT, sandbox, withoutSeat } from './helpers.mjs'
import { admits } from '../server/runtime/spending-policy.mjs'
import { remainingBudget } from '../server/supervisor-summary.mjs'

export default async function (t) {
  const model = (id, harness, extra = {}) => ({ id, model: `${id}-wire`, harness, contextWindow: 1000000, verification: { status: 'verified' }, ...extra })
  const a = model('a', 'claude'), b = model('b', 'codex')
  const roster = [a, b, model('small', 'codex', { contextWindow: 1000 }), model('unverified', 'codex', { verification: { status: 'unverified' } }), model('cooling', 'codex'), model('same-account', 'claude')]
  const availability = { check: async id => id === 'cooling' ? { reason: 'quota' } : null }
  const candidates = await fallbackCandidates({ models: roster, current: a, availability })
  t.eq('compatible verified models only, another account first', candidates.map(m => m.id), ['b', 'same-account'])
  t.eq('occupied seats excluded', (await fallbackCandidates({ models: roster, current: a, availability, excluded: ['b', 'same-account'] })).length, 0)
  t.eq('allowlist excludes other providers', (await fallbackCandidates({ models: roster, current: a, availability, allowedModels: ['b'] })).map(m=>m.id), ['b'])
  t.eq('empty allowlist disables substitution', (await fallbackCandidates({ models: roster, current: a, availability, allowedModels: [] })).length, 0)
  let probes=0
  const fallback=createQuotaFallback({loadModels:async()=>roster,availability,probeFor:()=>{probes++;throw Error('must not probe a forbidden model')}})
  const restricted={run:{participants:{implementer:{}},failures:[]},snapshot:{participants:{implementer:{model:b}},fallbackModels:['b']},participantSpec:()=>({model:b}),harnesses:{claude:{invoke(){}},codex:{invoke(){}}}}
  t.eq('engine stops when its allowed quota pool has no alternative',await fallback({engine:restricted,role:'implementer',spec:{model:b}}),null)
  t.eq('forbidden alternatives are never probed',probes,0)
  // A playbook restricting substitution: the implementation playbook with an
  // occupied auditor seat and an allowlist, as an operator would write it.
  const restrict=(list)=>sandbox(async root=>{
    const file=path.join(root,'playbooks','implementation.yaml')
    const text=withoutSeat(await fs.readFile(file,'utf8'),'auditor-1').replace('participants:\n','participants:\n  auditor-1:\n    model: gpt-6-sol\n')
    await fs.writeFile(file,text+['fallbackModels:',...list.map(id=>`  - ${id}`)].join('\n')+'\n')
  })
  const preset=await resolvePlaybook('implementation',{root:await restrict(['opus-5','gpt-6-astra','gpt-6-luna'])})
  t.ok('restricted preset resolves',preset.ok,JSON.stringify(preset.errors))
  t.eq('the assigned seats are unchanged by the allowlist',Object.fromEntries(Object.entries(preset.resolved?.participants??{}).map(([role,p])=>[role,p.model.id])),{'auditor-1':'gpt-6-sol',coordinator:'opus-5-5',implementer:'opus-5-5'})
  t.eq('fallback restriction survives into the immutable snapshot',preset.resolved?.fallbackModels,['opus-5','gpt-6-astra','gpt-6-luna'])
  t.eq('omitted allowlist keeps normal fallback',(await resolvePlaybook('implementation',{root:CONFIG_ROOT})).resolved?.fallbackModels??null,null)
  const invalidRoot=await restrict(['opus-5','nonexistent-model'])
  t.ok('unknown fallback model is a configuration error',!(await resolvePlaybook('implementation',{root:invalidRoot})).ok)

  const policy = { version: 1, daily: { usd: 100, starts: 1, unpricedRuns: 1, unpricedCalls: 1 }, monthly: { usd: 1000, starts: 1, unpricedRuns: 1, unpricedCalls: 1 }, concurrent: 3, perWakeCalls: 100 }
  const usage = { day: { committedUsdMicros: 100845329, committedUsd: 100.845329, starts: 999, unpricedRuns: 999, unpricedCalls: 999 }, month: { committedUsdMicros: 9999999999 } }
  for (const subject of ['model-call', 'run-start']) t.eq(`advisory ${subject} continues past all calendar estimates`, admits({ policy, usage, subject, maxCostUsd: 100000 }).ok, true)
  t.eq('concurrency still protects live work', admits({ policy, usage, subject: 'run-start', concurrent: 3 }).ok, false)
  const budget = remainingBudget({ limits: { maxCalls: 2000, maxRuns: 200, maxStartsPerIssue: 20 } }, { policy: { active: true, policy }, usage })
  t.eq('supervisor sees spending as nonbinding', budget.policy.decides, false)
  t.eq('supervisor receives recorded cost without exhausted allowance', budget.policy.windows.day.committedUsd, 100.845329)

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-quota-supervisor-'))
  const seen = [], exhausted = []
  const service = await createTopSupervisor({ dir, models: async () => [a, b], pollMs: 100,
    tools: { projects: async () => [], playbooks: async () => [], listIssues: async () => [],
      recordExhausted: async x => exhausted.push(x), availability: { check: async id => exhausted.some(x => x.modelId === id) ? {} : null } },
    adapter: { invoke: async args => {
      seen.push(args)
      if (args.model === 'a-wire') throw Object.assign(Error('Provider quota exhausted'), { stderr: 'insufficient_quota' })
      return { session: { id: 'fresh-session' }, response: JSON.stringify({ message: 'Continuing', action: null }), usage: { costUsd: 0 } }
    } }
  })
  try {
    await service.start({ model: 'a', message: 'Continue existing work' })
    const end = Date.now() + 5000
    while (service.get().status !== 'active' || seen.length < 2) {
      if (Date.now() > end) throw Error(`Supervisor failover timed out: ${service.get().reason}`)
      await new Promise(r => setTimeout(r, 10))
    }
    t.eq('supervisor switches provider after real quota error', seen.map(x => x.model), ['a-wire', 'b-wire'])
    t.eq('replacement starts a fresh session', seen[1].session, null)
    t.eq('mission is retained', service.get().mission, 'Continue existing work')
    t.eq('quota evidence recorded', exhausted[0].modelId, 'a')
    t.eq('supervisor remains active', service.get().status, 'active')
  } finally { await service.stop(); await service.shutdown(); await fs.rm(dir, { recursive: true, force: true }) }
}
