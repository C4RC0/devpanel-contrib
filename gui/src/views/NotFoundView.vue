<script setup>
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <v-container fluid class="notfound">
    <v-card elevation="0" border>
      <div class="empty">
        <div class="empty__mark">
          <v-icon icon="$compassOff" size="26" />
        </div>
        <h1 class="empty__title">Page not found</h1>
        <p class="empty__body">
          Nothing is routed to <code class="empty__path">{{ route.fullPath }}</code>.
        </p>
        <v-btn to="/" variant="tonal" size="small" prepend-icon="$arrowLeft" class="mt-5">
          Back to dashboard
        </v-btn>
      </div>
    </v-card>
  </v-container>
</template>

<style scoped>
.notfound {
  max-width: 1400px;
  padding: 28px 24px 40px;
}

.empty {
  padding: 64px 32px 72px;
  text-align: center;
  max-width: 30rem;
  margin: 0 auto;
}

.empty__mark {
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  margin: 0 auto 18px;
  border-radius: 14px;
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface-variant));
}

.empty__title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 8px;
}

.empty__body {
  font-size: 0.875rem;
  line-height: 1.65;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.empty__path {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  background: rgb(var(--v-theme-surface-variant));
  padding: 0.15em 0.4em;
  border-radius: 4px;
  overflow-wrap: anywhere;
}
</style>
