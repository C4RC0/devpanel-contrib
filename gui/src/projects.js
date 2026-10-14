import { ref, watch } from 'vue'

import { api } from '@/api'
import { isAuthenticated } from '@/auth'
import { socket } from '@/socket'

/**
 * One shared project list, taken from the <projects-root>/*-project directories. Reloading
 * re-scans that directory, so a project added on disk shows up on refresh.
 */
const projects = ref([])
const loading = ref(true)
const error = ref('')

let subscribed = false

export async function loadProjects () {
  try {
    projects.value = await api.listProjects()
    error.value = ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

export function useProjects () {
  // Load once, on whichever component asks first, and keep it current.
  if (!subscribed) {
    subscribed = true
    socket.on('issues:changed', loadProjects)
    // Load once the browser is admitted: by a token, or by a verified proxy login,
    // which has no token at all (src/identity.js), so authToken alone would never fire there.
    watch(isAuthenticated, (ok) => { if (ok) loadProjects() }, { immediate: true })
  }

  return { projects, loading, error, reload: loadProjects }
}
