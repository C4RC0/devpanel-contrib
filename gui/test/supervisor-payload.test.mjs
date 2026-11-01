import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { acknowledge, issuesChanged, issuesPage, overviewFor, readResult, shapeResult, RESULT_LIMIT } from '../server/supervisor-payload.mjs'
import { summarisePreview } from '../server/supervisor-summary.mjs'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'

export const name = 'supervisor payload — results shaped for the session, nothing dropped silently'

const issue = (id, extra = {}) => ({ id, project: 'p', name: `Issue ${id}`, status: 'open', openedOn: '2026-11-01', steps: Array.from({ length: 40 }, (_, n) => ({ number: n, text: 'x'.repeat(300) })), ...extra })

export default async function (t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-payload-'))
    try {
        t.section('a mutation is acknowledged, not echoed')
        const ack = acknowledge({ type: 'set_disposition', project: 'p' }, issue('a', { disposition: { value: 'resolved', runId: 'r1' }, warnings: ['residual risk unaccepted'] }))
        t.eq('it names the change and the issue as it stands', [ack.change, ack.issue.id, ack.issue.disposition, ack.issue.dispositionRun], ['set_disposition', 'a', 'resolved', 'r1'])
        t.eq('warnings are passed on', ack.warnings, ['residual risk unaccepted'])
        t.ok('the steps are not', !JSON.stringify(ack).includes('xxxx'))
        const shaped = await shapeResult({ type: 'archive_issue', project: 'p' }, issue('a', { archived: true }), { dir })
        t.eq('shapeResult acknowledges every issue mutation', [shaped.change, shaped.issue.archived], ['archive_issue', true])
        const error = { error: 'Set a disposition first' }
        t.eq('a refusal is shown as it is', await shapeResult({ type: 'archive_issue' }, error, { dir }), error)

        t.section('an issue list is paged, and says how much is left')
        const list = Array.from({ length: 120 }, (_, n) => issue(`i${n}`))
        const page = issuesPage(list, { project: 'p' })
        t.eq('fifty rows, the total and the rest counted', [page.issues.length, page.total, page.omitted], [50, 120, 70])
        t.ok('with the call for the next page', page.next.includes('offset:50'), page.next)
        const last = issuesPage(list, { project: 'p', offset: 100 })
        t.eq('the last page has no next', [last.issues.length, last.next], [20, undefined])

        t.section('the overview leaves its statistics out unless asked')
        const overview = { totals: { runs: 3 }, projects: [], byPlaybook: { a: {}, b: {} }, bySeat: { s: {} } }
        const lean = overviewFor(overview)
        t.ok('without byPlaybook and bySeat', !('byPlaybook' in lean) && !('bySeat' in lean))
        t.eq('but counted, with how to ask', [lean.statsOmitted.groups.byPlaybook, lean.statsOmitted.groups.bySeat], [2, 1])
        t.ok('one kind on request', 'bySeat' in overviewFor(overview, { stats: ['bySeat'] }) && !('byPlaybook' in overviewFor(overview, { stats: ['bySeat'] })))
        t.eq('everything with stats: true', overviewFor(overview, { stats: true }), overview)

        t.section('a result over the bound is kept whole and read on')
        const big = { rows: Array.from({ length: 3000 }, (_, n) => ({ n, text: 'y'.repeat(30) })) }
        const cut = await shapeResult({ type: 'get_run' }, big, { dir })
        t.ok('it is marked truncated with its size', cut.truncated === true && cut.chars > RESULT_LIMIT)
        let text = cut.page, next = cut.next, offset = cut.page.length
        while (next) { const r = await readResult({ dir, resultId: cut.resultId, offset }); text += r.page; offset += r.page.length; next = r.next }
        t.eq('and get_result pages give back exactly the whole result', JSON.parse(text), big)
        t.ok('an unknown id is refused', await readResult({ dir, resultId: '../x' }).then(() => false, (e) => e.status === 400))

        t.section('an issue-list change carries the difference')
        const before = JSON.stringify([{ id: 'a', status: 'open', name: 'Issue a' }, { id: 'b', status: 'open', name: 'Issue b' }])
        const change = issuesChanged('p', before, [issue('a', { status: 'closed' }), issue('c')])
        t.eq('changed and added rows', change.issues.map((i) => `${i.id}:${i.change}`), ['a:status open -> closed', 'c:added'])
        t.eq('removed ids and the total', [change.removed, change.total], [['b'], 2])

        t.section('a preview names check commands without their shell text')
        const command = { id: 'browser-check', run: 'z'.repeat(2000), kind: 'candidate', report: 'selftest' }
        const preview = summarisePreview({ ok: true, checks: { requirement: 'required', target: { kind: 'ssh', commands: [command], finallyCommands: [{ id: 'collect', run: 'z'.repeat(500), required: false }], baselineCache: { environment: 'q'.repeat(900) } } },
            infrastructure: { kind: 'boilerplate', orientation: 'read me', testDrive: { commands: [command] } } })
        t.eq('commands keep id, kind and report', preview.checks.target.commands, [{ id: 'browser-check', kind: 'candidate', report: 'selftest' }])
        t.eq('a non-gating command says so', preview.checks.target.finallyCommands, [{ id: 'collect', required: false }])
        t.ok('the test drive under infrastructure too, and prose stays', preview.infrastructure.testDrive.commands[0].run === undefined && preview.infrastructure.orientation === 'read me')
        t.ok('no shell text anywhere', !JSON.stringify(preview).includes('zzzz') && !JSON.stringify(preview).includes('qqqq'))

        t.section('the new arguments are part of the action contract')
        const reply = (action) => JSON.stringify({ message: 'm', action })
        t.ok('list_issues takes offset and limit', parseSupervisorResponse(reply({ type: 'list_issues', project: 'p', offset: 50, limit: 20 })))
        t.ok('overview takes stats', parseSupervisorResponse(reply({ type: 'overview', stats: ['byPlaybook'] })))
        t.ok('get_result needs a resultId', await Promise.resolve().then(() => parseSupervisorResponse(reply({ type: 'get_result' }))).then(() => false, () => true))
        t.ok('a negative offset is refused', await Promise.resolve().then(() => parseSupervisorResponse(reply({ type: 'list_issues', project: 'p', offset: -1 }))).then(() => false, () => true))
    } finally {
        await fs.rm(dir, { recursive: true, force: true })
    }
}
