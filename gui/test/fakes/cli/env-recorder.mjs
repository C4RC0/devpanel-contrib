#!/usr/bin/env node
/*
 * A CLI that does nothing but write down the environment it was spawned with.
 *
 * Testing `resolveConnection()` proves what the function returns; it proves
 * nothing about what the child process actually received, and the two came apart
 * badly once — the claude adapter resolved a connection it never passed the
 * account to, so a run assigned to one person's login would have gone out under
 * whoever was logged in ambiently.
 */
import fs from 'node:fs'

const out = process.env.DEVPANEL_ENV_RECORDER
if (out) {
  fs.appendFileSync(out, JSON.stringify({
    argv: process.argv.slice(2),
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL ?? null,
    ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? null,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
    // Gemini keeps login, settings and sessions under one home, so that home is
    // the account fence; the rest are what a login could be inherited from.
    GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME ?? null,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? null,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,
    GOOGLE_GENAI_USE_VERTEXAI: process.env.GOOGLE_GENAI_USE_VERTEXAI ?? null,
    GOOGLE_GENAI_USE_GCA: process.env.GOOGLE_GENAI_USE_GCA ?? null,
    GOOGLE_CLOUD_PROJECT: process.env.GOOGLE_CLOUD_PROJECT ?? null,
    GOOGLE_GEMINI_BASE_URL: process.env.GOOGLE_GEMINI_BASE_URL ?? null,
    HOME: process.env.HOME ?? null,
    // Every name the child received, so a test can prove an ABSENCE (the
    // allow-listed environment) and not only the values it asked about.
    envKeys: Object.keys(process.env).sort()
  }) + '\n')
}

// Enough of each CLI's surface for probe() and invoke() to get through.
if (process.argv.includes('--version')) { process.stdout.write('9.9.9 (fake)\n'); process.exit(0) }
const last = process.argv.find((a) => a.startsWith('--output-last-message='))
if (last) fs.writeFileSync(last.split('=')[1], 'OK')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK', session_id: 'fake-session', usage: {}, total_cost_usd: 0 }) + '\n')
process.exit(0)
