import http from 'node:http'

import express from 'express'

import { privateAddress, refusal, reportRouter, reportText } from '../server/report.mjs'
import { listen } from './helpers.mjs'

export const name = 'anonymous reporting — a private-network peer may open an issue and nothing else'

async function serve (options) {
  const app = express()
  app.use(reportRouter(options))
  const server = http.createServer(app)
  await listen(server, 0, '127.0.0.1')
  const post = async (project, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/report/${project}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json().catch(() => null) }
  }
  return { post, close: () => new Promise((resolve) => server.close(resolve)) }
}

export default async function (t) {
  t.section('1. who counts as the private network')
  t.eq('10/8, 172.16/12, 192.168/16', ['10.1.0.5', '172.16.1.1', '172.31.9.9', '192.168.1.2'].map(privateAddress), [true, true, true, true])
  t.eq('mapped IPv4 and IPv6 ULA', [privateAddress('::ffff:10.0.0.1'), privateAddress('fd12:3456::1')], [true, true])
  t.eq('public, loopback, 172.32', ['8.8.8.8', '127.0.0.1', '::1', '172.32.0.1'].map(privateAddress), [false, false, false, false])
  const own = new Set(['10.1.0.119'])
  const req = (address, headers = {}) => ({ socket: { remoteAddress: address }, headers })
  t.eq('a sibling container may', refusal(req('::ffff:10.1.0.7'), own), null)
  t.eq('haproxy (X-Forwarded-For) may not', refusal(req('10.1.0.1', { 'x-forwarded-for': '1.2.3.4' }), own), 'came through the proxy')
  t.eq('the panel itself may not', refusal(req('10.1.0.119'), own), 'from the panel itself')
  t.eq('loopback may not', refusal(req('127.0.0.1'), own), 'not from the private network')

  t.section('2. input is report text, never a path')
  t.eq('a single .md line becomes a heading', reportText('/home/alice/notes.md'), '# /home/alice/notes.md\n')
  t.eq('multi-line text stays', reportText('# Title\nbody'), '# Title\nbody')
  t.eq('empty is nothing', reportText('  '), null)

  t.section('3. the endpoint')
  {
    const s = await serve({ createIssue: async () => { throw new Error('must not be called') }, emit: () => {} })
    try {
      const r = await s.post('app-project', { input: '# x\ny' })
      t.eq('the real check refuses loopback', r.status, 403)
    } finally { await s.close() }
  }
  {
    const created = []
    const events = []
    let clock = 0
    const s = await serve({
      createIssue: async (project, args) => { created.push({ project, ...args }); return { project, id: `issue-${created.length}`, report: 'secret body' } },
      emit: (e) => events.push(e),
      now: () => clock,
      refuse: () => null,
      identify: async (key) => (key === 'good' ? { name: 'app-prod', project: 'app-project' } : key === 'other' ? { name: 'flex-prod', project: 'other-project' } : null)
    })
    try {
      const r = await s.post('app-project', { input: 'Checkout page 500s', actor: 'root', name: 'override' })
      t.eq('201 with only project, id and trust', [r.status, r.body], [201, { project: 'app-project', id: 'issue-1', trust: 'anonymous' }])
      t.eq('created as report text, named by nobody but "report"', [created[0].input, created[0].openedBy.user, created[0].name], ['# Checkout page 500s\n', 'report', undefined])
      t.eq('without a key it is anonymous whatever it claims', created[0].reportOrigin, { kind: 'fault', category: null, reporter: null, trust: 'anonymous' })
      t.eq('other panels are told', events[0], { reason: 'issue-created', project: 'app-project', id: 'issue-1' })
      t.eq('missing input is 400', (await s.post('app-project', {})).status, 400)
      const keyed = await s.post('app-project', { input: '# Crash\nstack', kind: 'fault', category: 'crash' }, { 'X-Devpanel-Reporter-Key': 'good' })
      t.eq('a keyed fault report is trusted as fault', [keyed.body.trust, created.at(-1).reportOrigin, created.at(-1).openedBy.user], ['fault', { kind: 'fault', category: 'crash', reporter: 'app-prod', trust: 'fault' }, 'app-prod'])
      const asked = await s.post('app-project', { input: '# Add export\nplease', kind: 'request', category: 'feature' }, { 'X-Devpanel-Reporter-Key': 'good' })
      t.eq('a keyed person relay is trusted as request', asked.body.trust, 'request')
      t.eq('an unknown key is refused, not downgraded', (await s.post('app-project', { input: 'x' }, { 'X-Devpanel-Reporter-Key': 'bad' })).status, 403)
      t.eq("another project's reporter is refused", (await s.post('app-project', { input: 'x' }, { 'X-Devpanel-Reporter-Key': 'other' })).status, 403)
      t.eq('an unknown kind is 400', (await s.post('app-project', { input: 'x', kind: 'order' })).status, 400)
      for (let i = 1; i < 20; i++) await s.post('app-project', { input: `r${i}` })
      // the keyed reports above count against the reporter, not this address
      t.eq('the 21st report within 10 minutes is 429', (await s.post('app-project', { input: 'one more' })).status, 429)
      clock += 10 * 60 * 1000
      t.eq('after the window it is accepted again', (await s.post('app-project', { input: 'later' })).status, 201)
    } finally { await s.close() }
  }
}
