/*
 * The live log, as data: merging what the socket and the backlog deliver, and
 * turning the runtime's event lines into readable rows.
 *
 * Kept free of Vue so the two things that went wrong in review — duplicated
 * entries when a backlog page and a socket event overlapped, and a gap that was
 * never filled — can be tested as functions of their inputs.
 */

import { formatHms, formatMTokens } from './format.js'

/**
 * Merge incoming entries into an ordered list keyed by sequence number.
 * Duplicates (the same seq arriving twice) are dropped; order is by seq, so an
 * entry that arrives late still lands in place. Returns the new list and the
 * highest seq present.
 */
export function mergeEntries (existing, incoming, { max = 5000 } = {}) {
  if (!incoming?.length) return { entries: existing, next: existing.at(-1)?.seq ?? 0 }
  const seen = new Set(existing.map((e) => e.seq))
  const fresh = incoming.filter((e) => Number.isInteger(e?.seq) && !seen.has(e.seq) && seen.add(e.seq))
  if (!fresh.length) return { entries: existing, next: existing.at(-1)?.seq ?? 0 }
  const merged = [...existing, ...fresh].sort((a, b) => a.seq - b.seq).slice(-max)
  return { entries: merged, next: merged.at(-1).seq }
}

/** True when `entries` has every seq from the first to the last — nothing to catch up. */
export function contiguous (entries) {
  for (let i = 1; i < entries.length; i++) if (entries[i].seq !== entries[i - 1].seq + 1) return false
  return true
}

const clip = (text, n = 400) => (text.length > n ? `${text.slice(0, n)}…` : text)

/** What one runtime event line says, as rows for the parsed view; null to skip it. */
export function describeEvent (event) {
  if (!event || typeof event !== 'object') return null
  // Claude Code stream-json
  if (event.type === 'system') {
    if (/thinking/.test(event.subtype ?? '')) return { kind: 'thinking', text: `thinking${event.estimated_tokens ? ` (~${event.estimated_tokens} tokens so far)` : ''}` }
    return { kind: 'system', text: `session ${event.session_id ?? ''} ${event.subtype ?? ''}`.trim() }
  }
  if (event.type === 'assistant') {
    const rows = []
    for (const c of event.message?.content ?? []) {
      if (c.type === 'text' && c.text) rows.push({ kind: 'text', text: c.text })
      if (c.type === 'tool_use') rows.push({ kind: 'tool', text: `${c.name ?? 'tool'} ${clip(JSON.stringify(c.input ?? {}), 300)}` })
      if (c.type === 'thinking' && c.thinking) rows.push({ kind: 'thinking', text: clip(c.thinking, 600) })
    }
    return rows.length ? rows : { kind: 'system', text: 'assistant message' }
  }
  if (event.type === 'user') {
    const rows = []
    for (const c of event.message?.content ?? []) {
      if (c.type === 'tool_result') {
        const body = typeof c.content === 'string' ? c.content : (c.content ?? []).map((x) => x.text ?? '').join('')
        rows.push({ kind: c.is_error ? 'error' : 'result', text: clip(body || '(empty result)', 600) })
      }
    }
    return rows.length ? rows : null
  }
  if (event.type === 'result') {
    // Cost as the panel reports it: time and tokens, never money.
    const used = event.usage ? ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].reduce((n, k) => n + (Number(event.usage[k]) || 0), 0) : null
    return { kind: 'done', text: `${event.subtype ?? 'result'}${event.is_error ? ' (error)' : ''}${event.duration_ms != null ? ` · ${formatHms(event.duration_ms)}` : ''}${used != null ? ` · ${formatMTokens(used)}` : ''}` }
  }
  // Codex exec --json
  if (event.type === 'item.started' || event.type === 'item.completed') {
    const item = event.item ?? {}
    if (item.type === 'agent_message') return event.type === 'item.completed' && item.text ? { kind: 'text', text: item.text } : null
    if (item.type === 'command_execution') return { kind: event.type === 'item.started' ? 'tool' : 'result', text: clip(event.type === 'item.started' ? (item.command ?? 'command') : (item.aggregated_output ?? item.output ?? `exit ${item.exit_code ?? '?'}`), 600) }
    if (item.type === 'reasoning') return event.type === 'item.completed' && item.text ? { kind: 'thinking', text: clip(item.text, 600) } : null
    return { kind: 'system', text: `${event.type} ${item.type ?? ''}`.trim() }
  }
  if (typeof event.type === 'string' && /^(turn|session|thread)\./.test(event.type)) return { kind: 'system', text: event.type }
  return { kind: 'system', text: clip(JSON.stringify(event), 300) }
}

/**
 * Rows for the parsed view. stdout chunks are re-joined and split on newlines,
 * so a chunk boundary inside a line is harmless; stderr and markers pass
 * through line by line.
 */
export function parseRows (entries) {
  const out = []
  let partial = ''
  const flushLine = (line, at) => {
    const t = line.trim()
    if (!t) return
    if (t.startsWith('{')) {
      try {
        const d = describeEvent(JSON.parse(t))
        if (d === null) return
        for (const r of Array.isArray(d) ? d : [d]) out.push({ ...r, at })
        return
      } catch { /* not an event line */ }
    }
    out.push({ kind: 'stdout', text: t, at })
  }
  for (const e of entries) {
    if (e.kind === 'stdout') {
      partial += e.text
      let nl
      while ((nl = partial.indexOf('\n')) >= 0) { flushLine(partial.slice(0, nl), e.at); partial = partial.slice(nl + 1) }
    } else if (e.kind === 'stderr') {
      for (const line of e.text.split('\n')) if (line.trim()) out.push({ kind: 'stderr', text: line, at: e.at })
    } else {
      out.push({ kind: e.kind, text: e.text, at: e.at })
    }
  }
  if (partial.trim()) out.push({ kind: 'stdout', text: partial, at: entries.at(-1)?.at ?? null, partial: true })
  return out
}
