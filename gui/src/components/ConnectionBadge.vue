<script setup>
import { computed } from 'vue'
import { connection } from '@/socket'

// Status never rests on color alone — every state carries an icon and a word.
const PRESENTATION = {
  online: { color: 'success', icon: '$checkCircle', label: 'Connected' },
  connecting: { color: 'warning', icon: '$sync', label: 'Connecting' },
  offline: { color: 'error', icon: '$alertCircle', label: 'Offline' }
}

const view = computed(() => PRESENTATION[connection.status] ?? PRESENTATION.offline)

const detail = computed(() => {
  if (connection.status === 'online') {
    return connection.latency === null ? 'Connected' : `${connection.latency} ms`
  }
  if (connection.status === 'connecting') {
    return connection.attempts > 0 ? `Retry ${connection.attempts}` : 'Connecting'
  }
  return 'Offline'
})
</script>

<template>
  <v-chip
    :color="view.color"
    variant="tonal"
    size="small"
    class="connection-badge"
    :title="connection.error ? `Socket: ${connection.error}` : view.label"
  >
    <v-icon
      :icon="view.icon"
      size="14"
      start
      :class="{ 'connection-badge__spin': connection.status === 'connecting' }"
    />
    <span class="connection-badge__detail">{{ detail }}</span>
  </v-chip>
</template>

<style scoped>
/* Below this the app bar has no room for both the page title and a latency
   reading. The icon keeps carrying the state, and the chip's title attribute
   keeps the detail for anyone who looks. */
@media (max-width: 400px) {
  .connection-badge__detail { display: none; }
  .connection-badge :deep(.v-icon--start) { margin-inline-end: 0; }
}

.connection-badge {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.connection-badge__spin {
  animation: connection-spin 1.4s linear infinite;
}

@keyframes connection-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .connection-badge__spin { animation: none; }
}
</style>
