import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { projectsRoot } from './project-path.mjs'
import { fencePolicy } from './runtime/confinement-policy.mjs'
import { hostPlatform } from './runtime/platform.mjs'

// The panel's own directory: issues, runs and their worktrees live under it,
// so this is the filesystem a busy panel fills up.
const PANEL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * CPU time is a cumulative counter, so a usage percentage only means something
 * between two samples. We keep the previous sample and diff against it.
 */
function sampleCpuTimes () {
  const totals = { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  for (const cpu of os.cpus()) {
    for (const key of Object.keys(totals)) totals[key] += cpu.times[key] ?? 0
  }
  return totals
}

let previous = sampleCpuTimes()

function cpuUsagePercent () {
  const current = sampleCpuTimes()
  let busyDelta = 0
  let totalDelta = 0

  for (const key of Object.keys(current)) {
    const delta = current[key] - previous[key]
    totalDelta += delta
    if (key !== 'idle') busyDelta += delta
  }
  previous = current

  if (totalDelta <= 0) return 0
  return clamp((busyDelta / totalDelta) * 100, 0, 100)
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round (value, digits = 1) {
  return Number(value.toFixed(digits))
}

/** A path as the panel shows it: the home directory as `~`. */
export function homeRelative (p, home = os.homedir()) {
  if (!p) return p ?? null
  if (p === home) return '~'
  return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p
}

/**
 * Static facts about the host — sent once on connect, they never change.
 * The issues directory is the caller's (issues.js ISSUES_DIR, from
 * DEVPANEL_ISSUES_DIR): it is configured on its own, never derived from the
 * projects root.
 */
export function hostInfo ({ platform = hostPlatform(), env = process.env, projectsDir = projectsRoot(), issuesDir = null } = {}) {
  const fence = fencePolicy({ platform, env })
  return {
    // Where this install keeps projects and issues, for the panel's texts.
    directories: { projects: homeRelative(projectsDir), issues: homeRelative(issuesDir) },
    // How seats are confined on this host (confinement-policy.mjs): the panel
    // flags 'unfenced' and 'refused' persistently (App.vue).
    fence: { mode: fence.mode, reason: fence.reason },
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    node: process.version,
    cpus: os.cpus().length,
    totalMemory: os.totalmem(),
    startedAt: Date.now() - Math.round(process.uptime() * 1000)
  }
}

/** Space on the panel's filesystem; null when it cannot be read. */
function diskUsage (dir = PANEL_ROOT) {
  try {
    const { blocks, bsize, bavail, bfree } = fs.statfsSync(dir)
    const total = blocks * bsize
    // `bavail` is what an unprivileged process may still write; the root
    // reserve (bfree - bavail) is counted as used, as df does.
    const free = bavail * bsize
    const used = total - bfree * bsize
    const usable = used + free
    return { path: dir, total, free, used, usedPercent: usable > 0 ? round((used / usable) * 100) : 0 }
  } catch {
    return null
  }
}

/** The live sample pushed to every connected client on each tick. */
export function metricsSnapshot (extra = {}) {
  const totalMemory = os.totalmem()
  const freeMemory = os.freemem()
  const usedMemory = totalMemory - freeMemory

  return {
    at: Date.now(),
    cpu: {
      usage: round(cpuUsagePercent()),
      load: os.loadavg().map((value) => round(value, 2))
    },
    memory: {
      total: totalMemory,
      free: freeMemory,
      used: usedMemory,
      usedPercent: round((usedMemory / totalMemory) * 100),
      rss: process.memoryUsage().rss
    },
    disk: diskUsage(),
    uptime: {
      process: Math.round(process.uptime()),
      system: Math.round(os.uptime())
    },
    ...extra
  }
}
