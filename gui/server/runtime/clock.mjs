/** Time is injected so engine tests are deterministic and never sleep. */
export const systemClock = {
  now: () => Date.now(),
  iso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => { const h = setTimeout(r, Math.max(0, ms)); if (h.unref) h.unref() }),
  /** Fire `fn` after `ms`; returns a cancel handle. */
  after (ms, fn) {
    const handle = setTimeout(fn, Math.max(0, ms))
    if (handle.unref) handle.unref()
    return () => clearTimeout(handle)
  }
}

export function manualClock (startMs = Date.parse('2026-09-10T00:00:00.000Z')) {
  let t = startMs
  let seq = 0
  const timers = new Map()

  const fireDue = () => {
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= t) { timers.delete(id); timer.fn() }
    }
  }

  return {
    now: () => t,
    iso: () => new Date(t).toISOString(),
    advance: (ms) => { t += ms; fireDue() },
    sleep: async (ms) => { t += ms; fireDue() },
    // Timers are clock-driven, so a deadline is testable without waiting.
    after (ms, fn) {
      const id = ++seq
      timers.set(id, { at: t + Math.max(0, ms), fn })
      return () => timers.delete(id)
    },
    pending: () => timers.size
  }
}
