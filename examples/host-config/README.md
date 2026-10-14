# Example host configuration

These files show what lives in an installation's own `host-config/` directory:

- `projects/`: its projects;
- `roster/`: roster entries that name a person's login (`account`), or its own copies
  of catalogue entries with its dated verification evidence;
- `releases/`: release targets;
- `live-reports/`: live-check reports (`npm run live` writes them there once `host-config/` exists);
- `settings.json`: its defaults (projects root, proxy login, script header markers,
  test-drive unit user, forbidden prefixes, seat guidance);
- `publish-denylist.txt`: what `npm run publish:check` must not find in the tracked tree;
- `docs/`: its own documentation and history, given to run seats with `seatGuidance`.

They use reserved `example.invalid` names, the `192.0.2.0/24` documentation addresses
and placeholders (`<REPOSITORY_URL>`, `<service-user>`). Nothing here is loaded: copy
what you need into `host-config/` and edit it. See
[docs/host-config.md](../../docs/host-config.md).
