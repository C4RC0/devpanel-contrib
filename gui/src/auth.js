import { computed, ref } from 'vue'

/*
 * The operator's bearer token.
 *
 * Kept in sessionStorage rather than localStorage: it survives a refresh, which
 * requirement 5 needs, but not the tab closing. It is never written to disk by
 * the browser and never appears in a URL.
 */

const KEY = 'devpanel.token'

const read = () => {
  try { return sessionStorage.getItem(KEY) } catch { return null }
}

const token = ref(read())
const rejected = ref(false)
// A verified reverse-proxy basic-auth login admits this browser without a token (server/proxy-user.mjs, src/identity.js).
const proxyLogin = ref(false)

export const authToken = computed(() => token.value)
export const hasProxyLogin = computed(() => proxyLogin.value)
export const isAuthenticated = computed(() => proxyLogin.value || (Boolean(token.value) && !rejected.value))

export function setProxyLogin (verified) {
  proxyLogin.value = verified === true
}
export const wasRejected = computed(() => rejected.value)

export function setToken (value) {
  token.value = value?.trim() || null
  rejected.value = false
  try {
    if (token.value) sessionStorage.setItem(KEY, token.value)
    else sessionStorage.removeItem(KEY)
  } catch { /* private mode */ }
}

/** Called when the server refuses the token, so the UI can ask again. */
export function markRejected () {
  rejected.value = true
  proxyLogin.value = false
}

export function signOut () {
  setToken(null)
  rejected.value = false
}

// Not Authorization: that header belongs to a basic-auth proxy in front (see server/auth.mjs).
export const authHeaders = () => (token.value ? { 'X-Devpanel-Token': token.value } : {})
