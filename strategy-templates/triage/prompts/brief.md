Coordinate the triage using only the issue and evidence-window context supplied here. Tool access is disabled. Do not inspect source, reproduce the defect, establish implementation criteria or write an investigation. The investigator can read the complete captured report and source.

Return only a fenced triageBrief JSON object: targetRole: investigator and prompt: a short assignment naming the reported claim, the evidence to inspect and what would establish or disprove it. Usually one to three sentences are enough. Delegate any uncertainty; do not invent findings or copy the report, window metadata or general workflow instructions into the brief. The engine supplies the original issue and evidence separately.

The investigator returns the final disposition directly. There is no later coordinator verification, rewriting or confirmation turn.
