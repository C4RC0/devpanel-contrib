import os from 'node:os'

/*
 * Tokenless operator access for a single-user development install
 * (DEVPANEL_AUTH=local, set by install-on-osx.sh). Off unless asked for.
 *
 * Decision: on such an install there is no seat fence, so the agents can read
 * .devpanel-token anyway; the token keeps protecting only against the browser.
 * This keeps that part. A request is admitted as the account running the
 * panel only when it is plainly local and not cross-site:
 *   - the server listens on loopback only (refused at startup otherwise);
 *   - Host names the loopback address and port: a DNS-rebinding page arrives
 *     with its own host name and is refused;
 *   - Origin, when sent, is that same address: a cross-site POST is refused;
 *   - Sec-Fetch-Site, when sent, is same-origin or none: a cross-site GET
 *     (an <img> or a link) is refused even though it carries no Origin.
 * Anything else falls through to the token, which still works.
 *
 * Pitfall: every local process (agents and candidate code included) is an
 * operator here. That is exactly what general §008 forbids on the panel hosts,
 * which is why it is opt-in and refused off loopback. On macOS seats are
 * refused unless the install also opted in to unfenced operation
 * (DEVPANEL_UNFENCED=acknowledged, runtime/confinement-policy.mjs); once it
 * has, an unfenced seat or the candidate code it runs can call this API as
 * the operator (start runs, answer questions, deliver).
 */

const LOOPBACK = ['127.0.0.1', '::1', 'localhost']

export function localLogin ({ env = process.env, host, port, user = os.userInfo().username } = {}) {
  if (env.DEVPANEL_AUTH !== 'local') return null
  if (!LOOPBACK.includes(host)) throw new Error(`DEVPANEL_AUTH=local needs HOST on loopback (${LOOPBACK.join(', ')}), not ${host}`)
  const names = new Set()
  for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
    names.add(`${name}:${port}`)
    if (Number(port) === 443) names.add(name)
  }
  const sameOrigin = (origin) => names.has(String(origin).replace(/^https?:\/\//, ''))
  const admits = (headers = {}) => {
    if (!names.has(headers.host)) return false
    if (headers.origin !== undefined && !sameOrigin(headers.origin)) return false
    const site = headers['sec-fetch-site']
    return site === undefined || site === 'same-origin' || site === 'none'
  }
  return { user, admits }
}

/** Mounted after identify() and before requireToken(): an admitted request carries a verified login. */
export function localLoginMiddleware (local) {
  return (req, _res, next) => {
    if (local && !req.login?.verified && local.admits(req.headers)) req.login = { user: local.user, verified: true }
    next()
  }
}
