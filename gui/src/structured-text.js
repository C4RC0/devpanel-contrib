/*
 * Text that is part prose, part JSON — a prompt with the engine's context
 * sections, a response that ends in a fenced result — split so each part can
 * be shown for what it is.
 *
 * JSON is found two ways: fenced (```json, or an unlabelled fence whose body
 * parses), and bare, starting at the beginning of a line. Bare JSON is located
 * with a string-aware bracket scan, never a regex, and only kept when it
 * actually parses; anything else stays prose, character for character.
 */

/** End (exclusive) of the balanced {…} or […] starting at `start`, or -1. */
export function scanJson (text, start) {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === '\\') i++
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

const tryParse = (text) => { try { return { ok: true, value: JSON.parse(text) } } catch { return { ok: false } } }

/** A string that is itself a JSON object or array: its value; otherwise undefined. */
export function embeddedJson (text) {
  if (typeof text !== 'string') return undefined
  const t = text.trim()
  if (t.length < 2 || !/^[[{]/.test(t) || !/[\]}]$/.test(t)) return undefined
  const parsed = tryParse(t)
  return parsed.ok && parsed.value !== null && typeof parsed.value === 'object' ? parsed.value : undefined
}

/**
 * [{ type: 'markdown', text } | { type: 'json', value, source }] in order.
 * Joining every segment's source gives back the input's content.
 */
export function segments (source) {
  const text = String(source ?? '')
  const out = []
  let prose = ''
  const flush = () => { if (prose.trim()) out.push({ type: 'markdown', text: prose }); prose = '' }
  let i = 0
  while (i < text.length) {
    const nl = text.indexOf('\n', i)
    const lineEnd = nl < 0 ? text.length : nl
    const line = text.slice(i, lineEnd)
    const next = nl < 0 ? text.length : nl + 1

    const fence = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(line)
    if (fence) {
      // The closing fence is the first line that starts with the same marker.
      let j = next
      let close = -1
      while (j < text.length) {
        const e = text.indexOf('\n', j)
        const l = text.slice(j, e < 0 ? text.length : e)
        if (l.trim().startsWith(fence[1])) { close = j; break }
        j = e < 0 ? text.length : e + 1
      }
      const bodyEnd = close < 0 ? text.length : close
      const body = text.slice(next, bodyEnd)
      const after = close < 0 ? text.length : (text.indexOf('\n', close) < 0 ? text.length : text.indexOf('\n', close) + 1)
      const lang = fence[2].toLowerCase()
      const parsed = (lang === 'json' || (!lang && /^\s*[[{]/.test(body))) ? tryParse(body) : { ok: false }
      if (parsed.ok) {
        flush()
        out.push({ type: 'json', value: parsed.value, source: text.slice(i, after) })
      } else {
        prose += text.slice(i, after)
      }
      i = after
      continue
    }

    if (/^[[{]/.test(line)) {
      const end = scanJson(text, i)
      if (end > 0) {
        const parsed = tryParse(text.slice(i, end))
        // Only when nothing but whitespace follows on the closing line.
        const rest = text.indexOf('\n', end)
        const tail = text.slice(end, rest < 0 ? text.length : rest)
        if (parsed.ok && !tail.trim()) {
          flush()
          out.push({ type: 'json', value: parsed.value, source: text.slice(i, end) })
          i = rest < 0 ? text.length : rest + 1
          continue
        }
      }
    }

    prose += text.slice(i, next)
    i = next
  }
  flush()
  return out
}
