# Installed release procedures

The Staging and Deployment playbooks run an installation's own release
procedure: a project's `infrastructure.release.targets` names, per environment,
the working directory and the command for each release phase (inspect,
checkpoint, verify-checkpoint, apply, verify-release, restart, observe, test,
restore, verify-restore). Models never supply that text; only the release
engine invokes a mutation ([Configuring releases](../../docs/tactical-playbooks.md#configuring-releases)).

A procedure belongs to the installation, not to devpanel. An installation keeps
its site procedures in this directory, for example `<site>.py` beside a
`<site>_remote.py` sent over SSH, as untracked files that its own Git excludes
(tools/migrate-host-config.mjs keeps them in place that way), and documents them
in `host-config/releases/README.md`. Projects grant seats read access with
`workspace.tooling.allowedRoots: [<checkout>/tools/releases]`; an allowed root
inside the panel's checkout must lie under `tools/`.

What is tracked here is shared:

- `host_targets.py`: where a site's targets are read. A procedure calls
  `targets_file('<site>', os.environ, HERE)`, which returns
  `<host-config>/releases/<site>-targets.json` when it exists and
  `<site>-targets.json` beside the procedure otherwise. The host-config directory
  follows the same rule as the loader (DEVPANEL_HOST_CONFIG_DIR, relative to the
  config root, `<config root>/host-config` when unset;
  [Host configuration](../../docs/host-config.md)). Releases started by the
  engine get the resolved absolute directory in their environment.
- `test_host_targets.py`: the lookup's tests, run by `npm test -- host-config`.

The targets file holds the SSH destination, instance directory, service and its
account (`serviceUser`), runtime and observation settings
([an example](../../examples/host-config/releases/example-targets.json)). No
credential values belong in it.

The engine gives every command `DEVPANEL_RELEASE_ID`, `DEVPANEL_RELEASE_ARCHIVE`,
`DEVPANEL_RELEASE_SHA256`, `DEVPANEL_RELEASE_ENVIRONMENT`,
`DEVPANEL_RELEASE_STATE_DIR` and `DEVPANEL_RELEASE_STARTED_AT`. A procedure
transfers only the engine's immutable archive, never the live checkout, verifies
its SHA256 on arrival, and checkpoints the instance before it changes anything.
