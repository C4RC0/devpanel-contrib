import { localLogin, localLoginMiddleware } from '../server/local-login.mjs'
import { requireToken, socketAuth } from '../server/auth.mjs'

export const name = 'local login — DEVPANEL_AUTH=local admits same-origin loopback requests without the token'

const env = { DEVPANEL_AUTH: 'local' }
const local = () => localLogin({ env, host: '127.0.0.1', port: 8443, user: 'dev' })
const pass = (mw, req) => new Promise((resolve) => {
  const res = { status: () => ({ json: () => resolve(false) }) }
  mw(req, res, () => resolve(true))
})
const handshake = (guard, headers) => new Promise((resolve) => guard({ handshake: { headers, auth: {} } }, (err) => resolve(!err)))

export default async function (t) {
  t.section('1. off unless asked for, and only on loopback')
  t.eq('no DEVPANEL_AUTH is off', localLogin({ env: {}, host: '127.0.0.1', port: 8443 }), null)
  let refused = null
  try { localLogin({ env, host: '0.0.0.0', port: 8443 }) } catch (err) { refused = err.message }
  t.ok('0.0.0.0 is refused at startup', /loopback/.test(refused ?? ''))

  t.section('2. host, origin and fetch site decide')
  const l = local()
  t.ok('same-origin browser request', l.admits({ host: '127.0.0.1:8443', origin: 'https://127.0.0.1:8443', 'sec-fetch-site': 'same-origin' }))
  t.ok('localhost spelling', l.admits({ host: 'localhost:8443' }))
  t.ok('a local CLI without browser headers', l.admits({ host: '127.0.0.1:8443' }))
  t.ok('typed address (Sec-Fetch-Site: none)', l.admits({ host: '127.0.0.1:8443', 'sec-fetch-site': 'none' }))
  t.ok('DNS rebinding: a foreign Host is refused', !l.admits({ host: 'evil.example:8443', 'sec-fetch-site': 'same-origin' }))
  t.ok('wrong port is refused', !l.admits({ host: '127.0.0.1:9000' }))
  t.ok('cross-site POST: foreign Origin is refused', !l.admits({ host: '127.0.0.1:8443', origin: 'https://evil.example' }))
  t.ok('Origin: null is refused', !l.admits({ host: '127.0.0.1:8443', origin: 'null' }))
  t.ok('cross-site GET without Origin is refused', !l.admits({ host: '127.0.0.1:8443', 'sec-fetch-site': 'cross-site' }))
  t.ok('same-site but other origin is refused', !l.admits({ host: '127.0.0.1:8443', 'sec-fetch-site': 'same-site' }))
  t.ok('port 443 may be omitted', localLogin({ env, host: '127.0.0.1', port: 443 }).admits({ host: 'localhost' }))

  t.section('3. the middleware stands in for the token; refusals still need it')
  const guard = requireToken('secret')
  const admitted = { path: '/api/runs', headers: { host: '127.0.0.1:8443' } }
  await pass(localLoginMiddleware(l), admitted)
  t.eq('admitted as the panel account', admitted.login, { user: 'dev', verified: true })
  t.ok('requireToken lets it through', await pass(guard, admitted))
  const foreign = { path: '/api/runs', headers: { host: 'evil.example:8443' } }
  await pass(localLoginMiddleware(l), foreign)
  t.ok('a refused request still needs the token', !(await pass(guard, foreign)))
  const off = { path: '/api/runs', headers: { host: '127.0.0.1:8443' } }
  await pass(localLoginMiddleware(null), off)
  t.ok('with the mode off nothing changes', !(await pass(guard, off)))

  t.section('4. the socket handshake follows the same rule')
  t.ok('local handshake admitted', await handshake(socketAuth('secret', { local: l }), { host: '127.0.0.1:8443', origin: 'https://127.0.0.1:8443' }))
  t.ok('foreign origin handshake refused', !(await handshake(socketAuth('secret', { local: l }), { host: '127.0.0.1:8443', origin: 'https://evil.example' })))
  t.ok('mode off: handshake refused', !(await handshake(socketAuth('secret'), { host: '127.0.0.1:8443' })))
}
