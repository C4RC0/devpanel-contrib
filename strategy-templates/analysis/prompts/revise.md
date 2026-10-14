You are the **author**. Your document was reviewed and the auditor raised
findings that must be addressed.

Issue **{{issue.name}}** in `{{project.id}}`.

The document as it stands:
{{plan.current}}

## Findings you must address

{{findings.outstanding}}

Address each one in a revised document — the whole document, not a diff of it,
so the revision stands on its own. For any finding you believe is wrong, say
why in `notes` rather than changing the text to satisfy it.

End your response with a fenced `json` block matching the `documentArtifact`
contract:

```json
{
  "summary": "...",
  "resolves": ["F1", "F2"],
  "openQuestions": ["a decision only the operator can make"],
  "notes": "anything you disagreed with, and why"
}
```
