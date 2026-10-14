import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/*
 * Build the real client as a single classic script.
 *
 * The production build emits ES modules, which jsdom will not execute. An IIFE
 * bundle of the same sources runs in jsdom unchanged — the components, router,
 * stores and socket client under test are the ones that ship, not stand-ins.
 */

let cached = null

export async function buildApp () {
  if (cached) return cached

  const { build } = await import('vite')
  const { default: vue } = await import('@vitejs/plugin-vue')
  const { default: vuetify } = await import('vite-plugin-vuetify')

  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-appbuild-'))

  await build({
    root: GUI,
    configFile: false,
    logLevel: 'error',
    plugins: [vue(), vuetify({ autoImport: true })],
    resolve: { alias: { '@': path.join(GUI, 'src') } },
    // A library build does not substitute these the way an app build does, and
    // the page has no `process` to fall back on. `process.env` -> {} is exactly
    // what the shipping app build emits.
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env': '{}',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false'
    },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      cssCodeSplit: false,
      // A library build so the output is one self-contained script with no
      // module syntax and no separate chunks to load.
      lib: {
        entry: path.join(GUI, 'src', 'main.js'),
        formats: ['iife'],
        name: 'DevpanelApp',
        fileName: () => 'app.js'
      }
    }
  })

  cached = { dir: outDir, file: path.join(outDir, 'app.js') }
  return cached
}

export async function cleanupBuild () {
  if (!cached) return
  await fs.rm(cached.dir, { recursive: true, force: true }).catch(() => {})
  cached = null
}
