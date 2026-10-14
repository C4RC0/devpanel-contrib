import os from 'node:os'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createAvailabilityStore } from '../server/runtime/failure.mjs'
import { availabilityReport } from '../server/availability-api.mjs'
import { manualClock } from '../server/runtime/clock.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export default async (t) => {
  t.section('the availability page lists every roster model with the host\'s record for it')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-avail-'))
    const clock = manualClock()
    const store = createAvailabilityStore(path.join(dir, 'a.json'), { clock })
    const empty = await availabilityReport({ store, configRoot: CONFIG_ROOT })
    t.ok('every roster model is listed', empty.models.length >= 5 && empty.models.every((m) => m.harness), empty.models.map((m) => m.id).join(','))
    t.eq('none exhausted', empty.exhausted, 0)
    t.ok('all available', empty.models.every((m) => m.state === 'available' && m.record === null))

    const first = empty.models[0].id
    await store.recordExhausted({ modelId: first, reason: 'weekly limit', runId: 'r1', role: 'author' })
    await store.recordExhausted({ modelId: 'retired-model', reason: 'old', retryAfterMs: 60_000 })
    const report = await availabilityReport({ store, configRoot: CONFIG_ROOT })
    t.eq('two exhausted', report.exhausted, 2)
    const row = report.models.find((m) => m.id === first)
    t.eq('the roster model shows its record', `${row.state}/${row.record.runId}/${row.record.assumed}`, 'exhausted/r1/true')
    const gone = report.models.find((m) => m.id === 'retired-model')
    t.eq('a record for a model no longer rostered is still shown', gone?.verification, 'not-in-roster')
    t.eq('exhausted models sort first', report.models.slice(0, 2).every((m) => m.state === 'exhausted'), true)

    clock.advance(2 * 60_000)
    const later = await availabilityReport({ store, configRoot: CONFIG_ROOT })
    const expired = later.models.find((m) => m.id === 'retired-model')
    t.eq('an expired record reads as available', expired.state, 'available')
    t.eq('but the record is kept for the page', expired.record?.active, false)

    t.section('an operator hold names an instant, and a past instant is refused')
    let threw = null
    try { await store.recordExhausted({ modelId: first, reason: 'x', until: '2020-01-01T00:00:00Z', actor: 'op' }) } catch (error) { threw = error }
    t.eq('a past hold is refused', threw?.status, 422)
    const held = await store.recordExhausted({ modelId: 'opus-5', reason: 'provider announced maintenance', until: new Date(clock.now() + 3 * 3_600_000).toISOString(), actor: 'op' })
    t.eq('a future hold is exact, not assumed', held.assumed, false)
    t.eq('and attributed', held.actor, 'op')
    t.ok('and checked as exhausted', Boolean(await store.check('opus-5')))
    await fs.rm(dir, { recursive: true, force: true })
  }
}
