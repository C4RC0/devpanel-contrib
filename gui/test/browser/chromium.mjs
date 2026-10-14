/*
 * A real browser, when the box can run one.
 *
 * jsdom answers "does the application behave", and nothing about layout: it has
 * no layout engine, so a clipped run id, a dialog whose buttons sit below the
 * fold, or a focus trap that never closes all look identical to working code.
 * Those need Chromium.
 *
 * It is not always available — a headless Chromium needs system libraries this
 * project does not install — so this module reports *why* it cannot run rather
 * than failing, and the suite skips.
 *
 * `tools/install-browser.sh` puts both the browser and its libraries under
 * gui/.browser, and this module finds them there without any environment set.
 *
 *   DEVPANEL_BROWSER_LIBS    override the library directories
 *   PLAYWRIGHT_BROWSERS_PATH override where the browser build lives
 *   DEVPANEL_REQUIRE_BROWSER =1 to fail rather than skip when it cannot launch,
 *                            which is what CI wants
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const GUI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/*
 * Where tools/install-browser.sh puts things. Owned by this project, so the
 * layout pass does not depend on any other project's directories.
 */
const OWNED_LIB = path.join(GUI, '.browser', 'lib')
const OWNED_BROWSERS = path.join(GUI, '.browser', 'playwright')

const exists = (p) => { try { return fs.existsSync(p) } catch { return false } }

const LIB_DIRS = (process.env.DEVPANEL_BROWSER_LIBS ?? (exists(OWNED_LIB) ? OWNED_LIB : ''))
  .split(':')
  .map((d) => d.trim())
  .filter(Boolean)

/** true when the caller insists on a browser rather than accepting a skip. */
export const browserRequired = process.env.DEVPANEL_REQUIRE_BROWSER === '1'

let cached = null

export async function launchChromium () {
  if (cached) return cached

  // The project's own browser, unless the caller pointed somewhere else.
  if (!process.env.PLAYWRIGHT_BROWSERS_PATH && exists(OWNED_BROWSERS)) {
    process.env.PLAYWRIGHT_BROWSERS_PATH = OWNED_BROWSERS
  }

  let chromium
  try {
    ({ chromium } = await import('playwright-core'))
  } catch {
    return { ok: false, reason: 'playwright-core is not installed' }
  }

  // Playwright sets its own LD_LIBRARY_PATH for the browser, so extra
  // directories have to be handed to launch() rather than merely exported.
  const env = LIB_DIRS.length
    ? { ...process.env, LD_LIBRARY_PATH: [...LIB_DIRS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
    : process.env

  try {
    const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'], env })
    // Launching is not rendering: without fontconfig the browser starts, then
    // aborts (Skia FATAL) the first time it lays out text, and a suite died
    // mid-way with "Target page, context or browser has been closed".
    try {
      const probe = await browser.newPage()
      await probe.setContent('<p style="font-family: sans-serif">render probe</p>')
      await probe.screenshot()
      await probe.close()
    } catch (error) {
      await browser.close().catch(() => {})
      return { ok: false, reason: `the browser starts but cannot render text (${String(error.message).split('\n')[0]}); install fontconfig and a font (e.g. dnf install fontconfig dejavu-sans-fonts)` }
    }
    cached = { ok: true, browser, version: browser.version() }
    return cached
  } catch (error) {
    const missing = String(error.message).match(/error while loading shared libraries: ([^:\n]+)/)
    return {
      ok: false,
      reason: missing
        ? `the browser needs ${missing[1]} — run tools/install-browser.sh`
        : /Executable doesn't exist/.test(error.message)
          ? 'no browser is installed — run tools/install-browser.sh'
          : String(error.message).split('\n')[0]
    }
  }
}

export async function closeChromium () {
  if (!cached?.ok) return
  await cached.browser.close().catch(() => {})
  cached = null
}
