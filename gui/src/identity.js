import { ref } from 'vue'
import { authHeaders, setProxyLogin } from '@/auth'

/*
 * Who is using the panel, as the reverse proxy's basic auth names them (GET /api/whoami).
 *
 * When the server verified that login (server/proxy-user.mjs) it admits the
 * browser without a token; when it only read the name (no users directory)
 * the token is still needed. Either way the name is the actor of
 * everything this browser does: the server overrides any `actor` a request
 * carries, so the "Your name" fields are hidden rather than prefilled. Without
 * the proxy it stays null and the fields come back, remembered per browser
 * under devpanel.actor.
 */

export const proxyUser = ref(null)

// Plain fetch, not api.js: a 401 here means "no login yet", not a rejected token.
export async function loadIdentity () {
  if (proxyUser.value) return
  try {
    const response = await fetch('/api/whoami', { headers: authHeaders() })
    const body = response.ok ? await response.json() : null
    proxyUser.value = body?.user ?? null
    setProxyLogin(body?.verified)
  } catch { /* offline: the token page stays the way in */ }
}

const KEY = 'devpanel.actor'

export function rememberedActor () {
  try { return localStorage.getItem(KEY) ?? '' } catch { return '' }
}

/** The name to send: the proxy user when there is one, else what was typed (remembered for next time). */
export function actorName (typed) {
  if (proxyUser.value) return proxyUser.value
  const name = String(typed ?? '').trim()
  if (name) { try { localStorage.setItem(KEY, name) } catch { /* per-browser convenience only */ } }
  return name
}
