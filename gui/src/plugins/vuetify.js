import 'vuetify/styles'

import { createVuetify } from 'vuetify'
import { aliases, mdi } from 'vuetify/iconsets/mdi-svg'

import { appIcons } from './icons'

/*
 * Both themes are chosen, not flipped. Each is a set of steps picked for its own
 * surface: the dark palette is the same hues re-stepped for a dark background,
 * so contrast holds in both directions.
 */
const ink = {
  light: { primary: '#0b0b0b', secondary: '#52514e', muted: '#898781', hairline: '#e1e0d9' },
  dark: { primary: '#ffffff', secondary: '#c3c2b7', muted: '#898781', hairline: '#2c2c2a' }
}

const light = {
  dark: false,
  colors: {
    background: '#f9f9f7',
    surface: '#fcfcfb',
    'surface-bright': '#ffffff',
    'surface-variant': '#eceae4',
    'on-surface-variant': '#52514e',
    primary: '#2a78d6',
    'on-primary': '#ffffff',
    secondary: '#52514e',
    'on-secondary': '#ffffff',
    info: '#2a78d6',
    success: '#0ca30c',
    warning: '#fab219',
    error: '#d03b3b',
    'on-background': ink.light.primary,
    'on-surface': ink.light.primary
  },
  variables: {
    'border-color': ink.light.primary,
    'border-opacity': 0.1,
    'theme-muted': ink.light.muted,
    'theme-secondary-ink': ink.light.secondary,
    'theme-hairline': ink.light.hairline,
    'high-emphasis-opacity': 1,
    'medium-emphasis-opacity': 0.72
  }
}

const dark = {
  dark: true,
  colors: {
    background: '#0d0d0d',
    surface: '#1a1a19',
    'surface-bright': '#242422',
    'surface-variant': '#2c2c2a',
    'on-surface-variant': '#c3c2b7',
    primary: '#3987e5',
    'on-primary': '#ffffff',
    secondary: '#c3c2b7',
    'on-secondary': '#0b0b0b',
    info: '#3987e5',
    success: '#0ca30c',
    warning: '#fab219',
    error: '#d03b3b',
    'on-background': ink.dark.primary,
    'on-surface': ink.dark.primary
  },
  variables: {
    'border-color': ink.dark.primary,
    'border-opacity': 0.1,
    'theme-muted': ink.dark.muted,
    'theme-secondary-ink': ink.dark.secondary,
    'theme-hairline': ink.dark.hairline,
    'high-emphasis-opacity': 1,
    'medium-emphasis-opacity': 0.72
  }
}

export default createVuetify({
  theme: {
    // 'system' follows the OS until the user picks a side with the toggle.
    defaultTheme: 'system',
    themes: { light, dark }
  },
  icons: {
    defaultSet: 'mdi',
    // Vuetify's own internal icons, plus this app's named icons.
    aliases: { ...aliases, ...appIcons },
    sets: { mdi }
  },
  defaults: {
    VCard: { rounded: 'lg' },
    VBtn: { rounded: 'md' },
    VTextField: { variant: 'outlined', density: 'comfortable' },
    VList: { density: 'comfortable' }
  }
})
