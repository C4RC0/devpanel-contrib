# devpanel on macOS

devpanel runs natively on a Mac as a per-user launchd agent installed by
`install-on-osx.sh`. Linux behaviour is the reference; this page says what is
different on a Mac, what is refused there, what is labelled, and what has not been
proved on a Mac yet. The last section is the checklist that proves it.

## Supported seats

Claude and Codex seats run on a Mac. Gemini seats do not (see "Gemini"). A Mac
has no bubblewrap, so there is no seat fence: what a seat may touch is decided only
by the CLI's own sandbox and permission rules (Claude permission deny rules and
`--add-dir`; Codex `--sandbox workspace-write`), never by a namespace. Roster
`account` entries isolate a login by `CLAUDE_CONFIG_DIR` / `CODEX_HOME`; on a Mac
that isolation is unproved for Claude (see "Proof status").

## Fence state and labels

The host's fence mode (`runtime/confinement-policy.mjs`) is one of:

| Mode | When | Seats | Local checks | Tooling commands |
| --- | --- | --- | --- | --- |
| `refused` | a Mac, by default | refused before they start | `local-refused`, nothing runs | refused |
| `unfenced` | a Mac whose install opted in: `DEVPANEL_UNFENCED=acknowledged bash install-on-osx.sh` | run as namespace 0 | `local-unconfined` | run unwrapped, labelled unconfined |

The opt-in is kept in the agent's plist across reinstalls; `DEVPANEL_UNFENCED=no
bash install-on-osx.sh` withdraws it. On Linux the modes are `fence` (seats and
local checks in the proved fence, `local-enforced`) and `off` (`DEVPANEL_FENCE=off`,
`local-unconfined`). Without bubblewrap `DEVPANEL_FENCE=off` and
`DEVPANEL_FENCE_UNPROVED=run` grant nothing: the opt-in is the only way to run
unfenced on a Mac. `GET /api/info` and the socket `hello` carry `host.fence`; the
panel shows `unfenced` and `refused` as a banner on every page, and an unfenced run
records `run.unfenced` (an "unfenced" chip on the issue page, a section in
`result.md`).

## Tooling and mounts

A project's declared `workspace.tooling.commands` reach seats unwrapped and
labelled unconfined: the offline wrapper (`/run/devpanel/tooling/offline`) needs a
network namespace a Mac does not have, so commands keep the network. Declared
`workspace.tooling.mounts` are bound only by a proved fence, so on a Mac every turn
with tools of a project that declares mounts is refused, naming the mount. Leave
mounts out of a Mac project's file.

## Local checks

A project without SSH staging declares its own checks in its
`host-config/projects/<id>.yaml` (docs/project-infrastructure.md "Local checks"):

```yaml
id: example-crate-project
checks:
  commands:
    - { id: fmt, run: cargo fmt --check }
    - { id: clippy, run: cargo clippy -- -D warnings }
    - { id: test, run: cargo test }
```

Implementation, plan-and-implement and refactoring runs rebuild each revision's
candidate in a temporary directory and run these commands in it, on every revision,
with each command's log under `issues/<project>/<issue>/runs/<run>/checks/<n>/`. A
failed required command sends the author another round. On a Mac the check is
`local-unconfined` under the opt-in and `local-refused` without it; a refused
required check is `unavailable` and the run cannot close. The installer installs
`rustup` and puts `~/.cargo/bin` on the agent's `PATH`. The project's file stays on
the Mac: `host-config/` is never synced.

## Gemini

Every Gemini seat is refused on a Mac, in preview, preflight and the adapter itself,
before any probe or launch: its read-only confinement needs bubblewrap. A playbook
that occupies a seat with a Gemini model cannot start there.

## Local authentication and its risk

The agent runs with `DEVPANEL_AUTH=local`: same-origin requests from loopback need
no token (`server/local-login.mjs`); the token in `~/devpanel/.devpanel-token` still
works. It is refused unless `HOST` is loopback. **The risk:** every local process is
the operator, unfenced seats and the candidate code they run included. They can
start runs, answer questions and deliver through the API. That is accepted only
because unfenced seats could read the token anyway.

## Projects and host configuration

Projects are `<name>-project` directories under `DEVPANEL_PROJECTS_DIR`
(`~/projects` by default), each a git repository. The issues directory is the
install's own `~/devpanel/issues` (`DEVPANEL_ISSUES_DIR` is not set by the
installer); the panel shows both, home as `~`, from `GET /api/info`
`host.directories`. `install-on-osx.sh` never syncs `projects/`, `host-config/`,
`issues/`, `logs/`, `cert/` or the token, so the Mac's own project files and host
configuration survive every reinstall (docs/host-config.md "macOS").

## Install and service

```sh
export DEVPANEL_SOURCE=<user>@<panel-host>:<panel checkout>/   # before every run, in that shell
bash ~/install-on-osx.sh                                       # first time (the copy fetched with scp)
bash ~/devpanel/install-on-osx.sh                              # every later run
```

The installer does not remember `DEVPANEL_SOURCE`: it is required on every run
and the installer stops with "set DEVPANEL_SOURCE to the rsync source of the panel"
without it. Export it in the shell first (or put the `export` line in your shell
profile) before each `bash ~/devpanel/install-on-osx.sh`.

The installer runs as the panel's owner, never with sudo. It installs `node@22`
(keg-only; the agent's `PATH` names its keg), `git`, `rsync` and `rustup` with
Homebrew, and the Claude and Codex CLIs into `~/.local`; syncs the source to
`~/devpanel`; builds the front end; and installs a per-user LaunchAgent at
`~/Library/LaunchAgents/<label>.plist`, listening on `https://127.0.0.1:8443/`.
The label is the one an earlier install of this script used (an installed
`*.devpanel` agent), else `local.devpanel`; `DEVPANEL_LAUNCHD_LABEL` names another.
In the commands below `<label>` is the label your install uses. The log is
`~/Library/Logs/devpanel.log`; stop the panel with
`launchctl bootout gui/$(id -u)/<label>`.

What the installer reads: `DEVPANEL_SOURCE` (required), `DEVPANEL_HOME`
(`~/devpanel`), `DEVPANEL_PROJECTS_DIR` (`~/projects`), `PORT` (8443), `HOST`
(127.0.0.1), `DEVPANEL_LAUNCHD_LABEL` and `DEVPANEL_UNFENCED`.

## Agent environment

The agent's plist sets exactly these environment variables, and no others:

| Variable | Value |
| --- | --- |
| `PATH` | `~/.local/bin`, the `node@22` keg, `~/.cargo/bin`, the `rustup` keg, the Homebrew prefix, the system paths |
| `NODE_ENV` | `production` |
| `PORT` | 8443, or the installer's `PORT` |
| `HOST` | 127.0.0.1, or the installer's `HOST` |
| `DEVPANEL_PROJECTS_DIR` | `~/projects`, or the installer's value |
| `DEVPANEL_AUTH` | `local` |
| `DEVPANEL_UNFENCED` | `acknowledged`, written only when the install opted in |
| `DEVPANEL_SHUTDOWN_GRACE_MS` | 20000 |

It no longer writes `DEVPANEL_FENCE`: an older agent's `DEVPANEL_FENCE=off` is not
an opt-in and is dropped on reinstall.

## Proof status

What the Linux test suites prove with fakes, they prove on Linux: the darwin code
paths (`platformFor('darwin', …)` with injected primitives), the refusal and opt-in
policy, the labels and the installer's plist text. What only a Mac can prove is
**unproved** until the checklist below has been run on one:

- **Process identity.** Start times come from `ps -o lstart` at whole-second
  precision (`startTimePrecision: 'second'`); boot identity from
  `sysctl -n kern.bootsessionuuid` (`darwin-boot:<uuid>`).
- **Escaped processes.** The reap scan reads `ps -E`; a complete-looking listing is
  accepted with `mechanism: 'unproved'`, anything less needs an operator
  acknowledgement.
- **Login isolation.** `npm run contract` skips two Claude assertions on every host:
  "an empty CLAUDE_CONFIG_DIR reports no login" (no Claude subcommand reports login
  state without being treated as a prompt) and "claude's ambient login differs from
  the isolated one" (that would be a paid call). They are unproved, on a Mac as
  everywhere.
- **Keychain (a stated limitation).** On macOS the Claude CLI may keep its login in
  the user's login Keychain rather than under `CLAUDE_CONFIG_DIR`. Then a roster
  `account` directory does not isolate one person's Claude login from another's on
  the same Mac account, and nothing in devpanel can prove that it does. Treat Claude
  `account` entries on a Mac as unisolated unless the Keychain step of the checklist
  shows otherwise.
- **Archive metadata.** An SSH test drive archives the candidate with the host's
  `tar` (bsdtar on a Mac); whether it adds AppleDouble `._*` members or extended
  attribute headers, which the remote exact-listing check would refuse, has not been
  reproduced. Archive creation is unchanged until the checklist's archive step
  establishes it.
- **Enforcement.** No seat, tooling command or local check is enforced on a Mac;
  `unfenced` mode labels them, it does not confine them.

## Mac proof checklist

Run each item on the Mac, as the panel's owner, and record the output beside the
expected one. A deviation is a finding, not a pass.

1. **Install.** First `export DEVPANEL_SOURCE=<user>@<panel-host>:<panel checkout>/`
   (the installer does not remember it), then `bash ~/devpanel/install-on-osx.sh`
   Expected: ends with `devpanel is up: https://127.0.0.1:8443/`, then the token,
   log and stop lines.
2. **Service.** `plutil -lint ~/Library/LaunchAgents/<label>.plist`
   Expected: `/Users/<you>/Library/LaunchAgents/<label>.plist: OK`.
   `launchctl print gui/$(id -u)/<label>`
   Expected: a block for `gui/<uid>/<label>` with `state = running` and the
   environment of "Agent environment" above, nothing more.
   With the default label these read `plutil -lint ~/Library/LaunchAgents/local.devpanel.plist`
   and `launchctl print gui/$(id -u)/local.devpanel`.
3. **Identity formats and escaped processes.** The issue's
   `node test/run.mjs lock|process-reap|baseline-cache|selection` means four
   separate runs (the runner takes one file-name filter, and `|` is a shell pipe):
   - `cd ~/devpanel/gui && node test/run.mjs lock`
   - `cd ~/devpanel/gui && node test/run.mjs process-reap`
   - `cd ~/devpanel/gui && node test/run.mjs baseline-cache`
   - `cd ~/devpanel/gui && node test/run.mjs selection`

   Expected: each ends `N passed, 0 failed`. `lock` proves the darwin boot id and
   `lstart` start times against real processes; `process-reap` that an escaped
   descendant is found by its tag through `ps -E`. Also
   `sysctl -n kern.bootsessionuuid` prints one uuid.
4. **Whole suite.** `cd ~/devpanel/gui && npm test`
   Expected: `0 failed`; any skips are listed with their reasons.
5. **Installed CLIs.** `cd ~/devpanel/gui && npm run contract`
   Expected: `0 failed, 2 skipped` or more skipped only for an absent CLI; the two
   Claude skips above are expected and stay unproved; codex reports
   `an empty CODEX_HOME reports no login` as passed.
6. **Keychain.** Open Keychain Access (or run `security dump-keychain | grep -i claude`)
   after logging in to `claude` once with a roster `account` directory and once
   without. Expected for isolation to hold: a separate credential per directory, or
   none in the Keychain. One shared Claude item means the limitation above applies.
7. **Case-insensitive APFS.** `diskutil info / | grep -i 'personality'`
   Expected: `APFS` (case-insensitive) or `Case-sensitive APFS`; record which. Then
   `cd ~/devpanel/gui && node test/run.mjs working-tree`. Expected: `0 failed`
   (with `selection` above, it covers how the untracked tree and owner selections
   read on this file system).
8. **Paths with spaces.**
   `mkdir -p "$HOME/tmp with space" && cd ~/devpanel/gui && TMPDIR="$HOME/tmp with space" node test/run.mjs checks`
   Expected: `0 failed` (check candidates are rebuilt under that directory).
9. **Executable bits.** The same `checks` run covers it: section
   "4e. a candidate that deletes a file is not blamed for its absence; a mode change
   is caught" passes.
10. **Archive metadata.**
    ```sh
    d="$(mktemp -d)"; mkdir "$d/c"; echo x > "$d/c/file.txt"; xattr -w com.example.test 1 "$d/c/file.txt"
    tar -C "$d/c" -cf "$d/a.tar" . && tar -tvf "$d/a.tar"
    COPYFILE_DISABLE=1 tar -C "$d/c" -cf "$d/b.tar" . && tar -tvf "$d/b.tar"
    ```
    Expected if there is no problem: both listings show only `./` and `./file.txt`.
    A `./._file.txt` member in the first listing confirms the risk; then
    `tar --no-mac-metadata -C "$d/c" -cf "$d/c.tar" .` should list without it.
    Record both listings; a confirmed risk is a new issue (darwin archive creation),
    and an SSH test drive from the Mac of a candidate with such a file is its proof.
11. **A local project check run.** With a project
    `~/projects/<name>-project` and its `host-config/projects/<name>-project.yaml`
    declaring the three cargo checks of "Local checks":
    `cd ~/devpanel/gui && npm run config:check -- implementation --project <name>-project`
    Expected: `checks     requirement=required target=local commands=fmt,clippy,test timing=every-revision`.
    Then run the implementation playbook on an issue of that project. Expected: each
    revision's `runs/<run>/checks/<n>/` holds `fmt.log`, `clippy.log` and `test.log`,
    the check records `confinement.level: local-unconfined` (opted in) or
    `local-refused` with nothing run (not opted in), and a failing `cargo test` sends
    the author another round.
