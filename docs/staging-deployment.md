# Shared staging deployment

The current tactical playbook model is documented in [Tactical playbooks](tactical-playbooks.md). It supersedes the legacy catalogue and single-auditor workflow described below for new runs.

Deploying/starting the shared staging instance is an operation the operator or the
top-level supervisor triggers, never an agent inside a run.
The analysis playbook only produces a document. The revision-bound test drive
boots an isolated candidate and preserves the shared instance. Neither performs
a shared deployment.

Projects may explicitly enable `infrastructure.stagingDeployment`, supplying a
host `workdir`, ordered `commands`, optional `diagnostics`, per-command deadlines, and operational notes.
Commands are installed operator configuration; models cannot supply shell text
or choose arbitrary hosts. All deployment commands must target the configured
staging instance. Production deployment remains unavailable through this action.

The top-level supervisor uses `deploy_staging {project,issueId}` on its own
judgement whenever deploying moves work forward: a delivered fix that test drives
or live verification need, a stale or broken staging instance, or a user request
(see [Top-level supervisor](top-level-supervisor.md)). The operation runs on the host with its existing
SSH access, outside the restricted author/reviewer process. Authoring agents are
briefed to leave this operation to the supervisor. After execution, the supervisor
assesses the recorded evidence and saves its assessment using `add_note`.

Operators can invoke the same operation directly as the service account:

```sh
node gui/server/staging-deployment-cli.mjs <project-id> <issue-id>
```

A typical configuration runs the application's own reviewed staging deployment
script, which copies current application/framework source, preserves instance secrets/data,
installs dependencies, starts the shared service and checks readiness. Installation
can update staging OS packages/service configuration; normal boot can migrate its
own database. It then collects the journal for the first 180 seconds following
service start, verifies the invocation has not changed, and checks the service is
still active. This is operational evidence, not a full functional test suite.

Results live in `<issue>/operations/staging-deployment.json` and an issue note.
The first operation is persisted before command execution. A project lock excludes
concurrent operations. Repeated requests for the same issue return the existing
result; they never re-run commands, including after failure. A previous running
record is reported as recovery-required after interruption. Inspect partial
remote effects before retrying. An operator may use the CLI option
`--retry-failed <operation-id>` after fixing a diagnosed failure. It requires the
exact failed attempt, archives that record, and links the new attempt via
`retryOf`. This option is not exposed to model actions; interrupted/running
operations cannot be retried this way.
There is no automatic rollback or production promotion. Cancellation terminates
the local process group, but remote effects may remain and require inspection.

The operation refuses disabled project configuration, archived issues, and an
active run on the same issue. Bounded stdout/stderr and command exit status are
retained; truncation is explicitly recorded. A failed action skips remaining actions but still runs configured diagnostics. A diagnostic failure also prevents success. Cancellation stops further commands. The observation command refuses to label a service start older than the operation as new deployment evidence.
Shared deployment does not mark source revisions approved or automatically close
an issue. The historical analysis triage result stays unchanged.
