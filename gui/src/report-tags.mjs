/*
 * The chips of a reported issue (issue.report from POST /api/report, server/report.mjs),
 * shared by the issue list and the issue page so both read the same.
 *
 * Two separate chips on purpose: the category (error, warning, crash) is what the
 * deployment says happened; the report chip's trust is what the top-level supervisor
 * may start on it (server/reporters.mjs). An operator is never bound by the trust.
 */
const TRUST_TITLE = {
  anonymous: 'Reported without a key: the supervisor starts nothing on it',
  fault: "A deployment's own error report: the supervisor may act on it as far as its reporter allows",
  request: 'A person, relayed by a deployment: the supervisor may act on it as far as its reporter allows (by default only triage or analysis)'
}
const TRUST_COLOUR = { fault: 'secondary', request: 'info' }

// Only the categories a framework raises by itself get a chip; bug/feature stay in the title.
const CATEGORY = {
  error: { color: 'error', icon: '$alertCircle', title: 'The deployment reported an error' },
  crash: { color: 'error', icon: '$alertCircle', title: 'The deployment reported a crash' },
  warning: { color: 'warning', icon: '$alert', title: 'The deployment reported a warning' }
}

/** Chips as {key, text, color, icon, title}; `opener` is the user@host that reported it. */
export function reportTags (report, opener = '') {
  if (!report) return []
  const tags = []
  const category = CATEGORY[report.category]
  if (category) tags.push({ key: 'category', text: report.category, ...category })
  const detail = [opener, report.category].filter(Boolean).join(', ')
  tags.push({
    key: 'report',
    text: 'report',
    color: TRUST_COLOUR[report.trust],
    icon: '$report',
    title: `${TRUST_TITLE[report.trust] ?? `Trust: ${report.trust}`}${detail ? ` (${detail})` : ''}`
  })
  return tags
}
