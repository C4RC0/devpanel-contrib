import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { CONFIG_ROOT } from './helpers.mjs'

const exec = promisify(execFile)
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-installer-'))
  const bin = path.join(root, 'bin'), record = path.join(root, 'calls')
  await fs.mkdir(bin)
  const shim = async (name, body) => fs.writeFile(path.join(bin, name), `#!/bin/bash\nprintf '%s\\n' '${name}'" $*" >> "$INSTALL_TEST_RECORD"\n${body}\n`, { mode: 0o755 })
  try {
    await fs.symlink('/usr/bin/dirname', path.join(bin, 'dirname'))
    await shim('id', 'if [[ "$#" == 1 ]]; then printf "%s\\n" "${INSTALL_TEST_UID:-0}"; else printf "804\\n"; fi')
    await shim('systemctl', 'if [[ "$1" == show ]]; then printf "paneluser\\n"; fi')
    await shim('systemd-detect-virt', 'printf "%s\\n" "${INSTALL_TEST_CONTAINER:-systemd-nspawn}"')
    await shim('mountpoint', 'exit 0')
    await shim('findmnt', 'printf "%s\\n" "${INSTALL_TEST_FSTYPE:-proc}"')
    await shim('install', 'exit 0')
    await shim('runuser', 'exit "${INSTALL_TEST_BWRAP_FAIL:-0}"')
    await shim('dnf', 'printf "#!/bin/bash\\nexit 0\\n" > "$PATH/bwrap"; /usr/bin/chmod +x "$PATH/bwrap"; /usr/bin/cp "$PATH/bwrap" "$PATH/socat"')
    const run = async (extra = {}) => {
      await fs.writeFile(record, '')
      let failed = false
      try {
        await exec('/bin/bash', [path.join(CONFIG_ROOT, 'gui/tools/install-sandbox.sh')], { env: { PATH: bin, INSTALL_TEST_RECORD: record, ...extra } })
      } catch { failed = true }
      return { failed, calls: await fs.readFile(record, 'utf8') }
    }
    const first = await run()
    t.eq('root installation succeeds', first.failed, false)
    t.ok('missing dependencies are installed through Fedora package manager', first.calls.includes('dnf install -y bubblewrap socat'))
    t.ok('persistent mount unit is installed', first.calls.includes('/etc/systemd/system/run-devpanel-proc.mount'))
    t.ok('service dependency is installed', first.calls.includes('/etc/systemd/system/devpanel.service.d/sandbox.conf'))
    t.ok('mount is enabled and started', first.calls.includes('systemctl enable --now run-devpanel-proc.mount'))
    t.ok('verification runs as service account', first.calls.includes('runuser -u paneluser -- bwrap --ro-bind / / --unshare-user --unshare-pid --proc /proc -- /usr/bin/true'))
    const second = await run()
    t.ok('repeat installation succeeds without reinstalling packages', !second.failed && !second.calls.includes('dnf install'))
    t.ok('sandbox failure fails installation', (await run({ INSTALL_TEST_BWRAP_FAIL: '1' })).failed)
    const nonroot = await run({ INSTALL_TEST_UID: '804' })
    t.ok('nonroot invocation stops before system changes', nonroot.failed && !nonroot.calls.includes('install '))
    const conflict = await run({ INSTALL_TEST_FSTYPE: 'tmpfs' })
    t.ok('unexpected existing mount is not overwritten', conflict.failed && !conflict.calls.includes('install '))
    const other = await run({ INSTALL_TEST_CONTAINER: 'none' })
    t.ok('ordinary hosts verify without installing the nspawn workaround', !other.failed && !other.calls.includes('install ') && other.calls.includes('runuser '))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
}
