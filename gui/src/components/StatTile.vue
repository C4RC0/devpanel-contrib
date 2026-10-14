<script setup>
import { computed } from 'vue'

const props = defineProps({
  label: { type: String, required: true },
  value: { type: [String, Number], default: '—' },
  unit: { type: String, default: '' },
  caption: { type: String, default: '' },
  icon: { type: String, default: '' },
  // Optional 0–100 meter drawn under the value.
  percent: { type: Number, default: null },
  loading: { type: Boolean, default: false }
})

// The number is always on screen, so the meter's color is reinforcement,
// never the only thing carrying the reading.
const meterColor = computed(() => {
  if (props.percent === null) return 'primary'
  if (props.percent >= 90) return 'error'
  if (props.percent >= 75) return 'warning'
  return 'primary'
})
</script>

<template>
  <v-card class="stat-tile" elevation="0" border>
    <div class="stat-tile__head">
      <span class="stat-tile__label">{{ label }}</span>
      <v-icon v-if="icon" :icon="icon" size="18" class="stat-tile__icon" />
    </div>

    <v-skeleton-loader v-if="loading" type="heading" class="stat-tile__skeleton" />
    <div v-else class="stat-tile__value">
      {{ value }}<span v-if="unit" class="stat-tile__unit">{{ unit }}</span>
    </div>

    <v-progress-linear
      v-if="percent !== null"
      :model-value="percent"
      :color="meterColor"
      height="4"
      rounded
      class="stat-tile__meter"
      bg-opacity="0.12"
    />

    <div v-if="caption" class="stat-tile__caption">{{ caption }}</div>
  </v-card>
</template>

<style scoped>
.stat-tile {
  padding: 18px 20px 20px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.stat-tile__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.stat-tile__label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}

.stat-tile__icon {
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.38;
}

.stat-tile__value {
  margin-top: 10px;
  font-size: 2rem;
  font-weight: 600;
  line-height: 1.15;
  /* Values refresh every couple of seconds; tabular figures keep them from
     jittering as digits change width. */
  font-variant-numeric: tabular-nums;
}

.stat-tile__unit {
  font-size: 1rem;
  font-weight: 500;
  margin-left: 3px;
  opacity: 0.55;
}

.stat-tile__skeleton {
  margin-top: 10px;
  background: transparent;
}

.stat-tile__meter {
  margin-top: 14px;
}

.stat-tile__caption {
  margin-top: 10px;
  font-size: 0.8125rem;
  color: rgb(var(--v-theme-on-surface));
  opacity: 0.62;
}
</style>
