/*
 * Markdown, drawn for a terminal.
 *
 * The models answer in Markdown. A terminal cannot render it, but it can do
 * what CLI tools do with it: headings in bold colour, `code` in cyan, lists as
 * bullets, fenced code as an indented block, tables as aligned columns. The
 * words are never changed — only the markers that a reader would otherwise
 * have to parse by eye are turned into styling.
 *
 * Inline markers are removed first and remembered as ranges over the plain
 * text; the plain text is wrapped; each wrapped line is then styled from the
 * ranges it overlaps. So a bold phrase broken across two lines stays bold on
 * both, and wrapping counts only the characters a person sees.
 */

const ESC = '\x1b['
const SGR = { bold: '1', italic: '3', dim: '2', underline: '4', strike: '9', code: '36', link: '4;34', heading: '1;34', quote: '2', rule: '90', jsonKey: '34', jsonString: '32', jsonLiteral: '35' }
const on = (styles) => styles.length ? `${ESC}${styles.map((s) => SGR[s]).join(';')}m` : ''
const OFF = `${ESC}0m`

/** Inline Markdown → { text, ranges: [{ from, to, style }] } over the text a person sees. */
export function parseInline (source) {
  let text = ''
  const ranges = []
  let i = 0
  const s = String(source)
  const push = (content, style) => {
    const from = text.length
    const inner = parseInline(content)
    text += inner.text
    for (const r of inner.ranges) ranges.push({ from: from + r.from, to: from + r.to, style: r.style })
    if (style) ranges.push({ from, to: text.length, style })
  }
  while (i < s.length) {
    const rest = s.slice(i)
    let m
    if ((m = /^`([^`]+)`/.exec(rest))) {                     // code: literal, no nested markers
      const from = text.length
      text += m[1]
      ranges.push({ from, to: text.length, style: 'code' })
      i += m[0].length
    } else if ((m = /^(\*\*|__)(?=\S)([\s\S]+?)(?<=\S)\1/.exec(rest))) {
      push(m[2], 'bold'); i += m[0].length
    } else if ((m = /^~~(?=\S)([\s\S]+?)(?<=\S)~~/.exec(rest))) {
      push(m[1], 'strike'); i += m[0].length
    } else if ((m = /^\*(?=\S)([^*]+?)(?<=\S)\*/.exec(rest)) ||
      // _italic_ only between non-word characters, so snake_case stays as it is.
      ((i === 0 || /\W/.test(s[i - 1])) && (m = /^_(?=\S)([^_]+?)(?<=\S)_(?!\w)/.exec(rest)))) {
      push(m[1], 'italic'); i += m[0].length
    } else if ((m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest))) {
      push(m[1], 'link')
      // The address is kept: in a terminal it is the only way to follow the link.
      if (m[2] !== m[1]) {
        const from = text.length
        text += ` (${m[2]})`
        ranges.push({ from, to: text.length, style: 'dim' })
      }
      i += m[0].length
    } else {
      text += s[i]; i += 1
    }
  }
  return { text, ranges }
}

/** Where to break `text` so no line is wider than `width`: [from, to) pairs. */
function breaks (text, width) {
  if (!width || text.length <= width) return [[0, text.length]]
  const out = []
  let start = 0
  while (text.length - start > width) {
    let cut = text.lastIndexOf(' ', start + width)
    if (cut <= start + width * 0.5) cut = start + width
    out.push([start, cut])
    start = text[cut] === ' ' ? cut + 1 : cut
  }
  out.push([start, text.length])
  return out
}

/** One styled line: the characters from..to with the ranges that cover them. */
function styleSlice (text, ranges, from, to, base = []) {
  let out = ''
  let current = null
  for (let i = from; i < to; i++) {
    const styles = [...base, ...ranges.filter((r) => r.from <= i && i < r.to).map((r) => r.style)]
    const key = styles.join(',')
    if (key !== current) { out += (current ? OFF : '') + on(styles); current = key }
    out += text[i]
  }
  return out + (current ? OFF : '')
}

/** Inline Markdown, wrapped to `width` and styled: an array of lines. */
export function inlineLines (source, width, base = []) {
  const { text, ranges } = parseInline(source)
  return breaks(text, width).map(([a, b]) => styleSlice(text, ranges, a, b, base))
}

/*
 * JSON, lightly coloured — the agents end every turn with a JSON object, and
 * keys, strings and literals in different colours make it scannable. Other
 * code is shown in one colour: a guessed highlighter would be wrong as often
 * as right.
 */
const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g
function codeRanges (line, lang) {
  if (lang !== 'json') return []
  const ranges = []
  for (const m of line.matchAll(JSON_TOKEN)) {
    const style = m[1] ? (m[2] ? 'jsonKey' : 'jsonString') : 'jsonLiteral'
    ranges.push({ from: m.index, to: m.index + (m[1] ? m[1].length : m[0].length), style })
  }
  return ranges
}

const visible = (cell) => parseInline(cell).text

function splitRow (line) {
  return line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim())
}

/** A Markdown table as aligned columns; as "a · b" lines when it would not fit. */
function table (rows, width) {
  const cells = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(splitRow)
  if (!cells.length) return []
  const cols = Math.max(...cells.map((r) => r.length))
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...cells.map((r) => visible(r[c] ?? '').length)))
  const total = widths.reduce((n, w) => n + w, 0) + (cols - 1) * 3
  if (width && total > width) {
    return cells.flatMap((r, i) => inlineLines(r.join(' · '), width, i === 0 ? ['bold'] : []))
  }
  const line = (r, header) => r.concat(Array(cols - r.length).fill('')).map((c, i) => {
    const { text, ranges } = parseInline(c)
    return styleSlice(text, ranges, 0, text.length, header ? ['bold'] : []) + ' '.repeat(widths[i] - text.length)
  }).join(`${on(['rule'])} │ ${OFF}`)
  const rule = on(['rule']) + widths.map((w) => '─'.repeat(w)).join('─┼─') + OFF
  return [line(cells[0], true), rule, ...cells.slice(1).map((r) => line(r, false))]
}

/**
 * A Markdown document as terminal lines, each at most `width` visible
 * characters (0 = do not wrap). Blank lines are kept, but never two in a row.
 */
export function markdownLines (source, width = 0) {
  const lines = String(source ?? '').replace(/\r/g, '').replace(/\t/g, '  ').split('\n')
  const out = []
  const blank = () => { if (out.length && out.at(-1) !== '') out.push('') }
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let m
    // ```lang … ``` — shown literally, indented behind a rule, cut rather than wrapped.
    if ((m = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/.exec(line))) {
      const fence = m[1]
      const body = []
      i += 1
      while (i < lines.length && !lines[i].trim().startsWith(fence)) body.push(lines[i++])
      i += 1
      const lang = m[2].toLowerCase()
      if (lang) out.push(on(['rule']) + `  ┌ ${lang}` + OFF)
      // Wrapped, not cut: every character of the block stays readable; a
      // continuation is marked so it is not mistaken for a line of its own.
      const room = width ? width - 4 : 0
      for (const b of body) {
        // Coloured as a whole line, then split, so a wrapped string keeps its colour.
        const ranges = codeRanges(b, lang)
        const base = lang === 'json' ? [] : ['code']
        const pieces = room && b.length > room ? breaks(b, room) : [[0, b.length]]
        pieces.forEach(([x, y], k) => out.push(on(['rule']) + (k === 0 ? '  │ ' : '  ┆ ') + OFF + styleSlice(b, ranges, x, y, base)))
      }
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++])
      out.push(...table(rows, width))
      continue
    }
    i += 1
    if (!line.trim()) { blank(); continue }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      blank()
      out.push(...inlineLines(m[2], width, m[1].length <= 2 ? ['heading'] : ['bold']))
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(on(['rule']) + '─'.repeat(Math.min(width || 40, 40)) + OFF)
      continue
    }
    if ((m = /^\s*>\s?(.*)$/.exec(line))) {
      for (const l of inlineLines(m[1], width ? width - 2 : 0, ['quote'])) out.push(on(['rule']) + '│ ' + OFF + l)
      continue
    }
    if ((m = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line))) {
      const depth = Math.floor(m[1].length / 2)
      const marker = m[3] ? (m[3].includes(' ]') ? '☐' : '☑') : /\d/.test(m[2]) ? m[2] : ['•', '◦', '▪'][depth % 3]
      const pad = '  '.repeat(depth)
      const hang = ' '.repeat(marker.length + 1)
      inlineLines(m[4], width ? width - pad.length - hang.length : 0)
        .forEach((l, k) => out.push(pad + (k === 0 ? `${marker} ` : hang) + l))
      continue
    }
    out.push(...inlineLines(line.trim(), width))
  }
  while (out.length && out.at(-1) === '') out.pop()
  return out
}
