const labels = { continue: 'Continue the playbook', 'close-issue': 'Close the issue', 'needs-input': 'Needs clarification' }
const valid = (value) => value && Object.hasOwn(labels, value.action) && typeof value.reason === 'string' && value.reason.trim()

export function triageSuggestion (snapshot, run, outputs, override = null) {
  const hasTriage = snapshot?.phases?.some((p) => (p.loop?.steps ?? [p.step]).some((s) => s?.output === 'triageResult'))
  if (!hasTriage) return null
  const triage = [...run.steps].reverse().map((s) => outputs[s.number]).find((o) => o?.valid === true && o.contract === 'triageResult')
  if (triage && override?.source === 'operator' && valid(override)) {
    return { action: override.action, label: labels[override.action], reason: override.reason, source: 'operator' }
  }
  const suggestion = triage?.output?.suggestion
  if (valid(suggestion)) return { ...suggestion, label: labels[suggestion.action], source: 'coordinator' }
  return { action: null, label: triage ? 'Not recorded' : 'Awaiting triage', reason: null, source: null }
}
