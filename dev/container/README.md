# Isolated Home Assistant container

This development instance uses HA 2026.10.1, matching the existing venv helper's
default. It listens only on `http://127.0.0.1:18123`. It uses synthetic fixtures,
not the production configuration repository. No privileged mode, host network,
device passthrough, or production mounts are used.

Prerequisites: Node 24, the repository's pinned Yarn, Docker with Compose, and
Docker Desktop running. Frontend dependencies live in `node_modules`; Home
Assistant and its Python dependencies run inside the container.

```sh
yarn install --immutable
yarn build
yarn typecheck
yarn test --run
yarn biome ci .
bash dev/container/start.sh
```

`start.sh` initializes configuration only when missing, starts HA, creates a
disposable administrator, and registers FLODE. Open
[the test panel](http://127.0.0.1:18123/flode). The generated login is stored in
`dev/container/runtime/credentials.json`; use it for manual browser login.
Credentials, tokens, HA storage, and logs are ignored by Git. Do not publish
the runtime directory. The integration mount is read-only; HA's isolated config
directory is writable so the original upstream editing tests can run.

Rebuild after frontend changes with `yarn build`, then reload the browser.
After Python changes, restart HA:

```sh
docker compose -f dev/container/compose.yaml restart
docker compose -f dev/container/compose.yaml logs --tail 100
docker compose -f dev/container/compose.yaml exec -T homeassistant \
  python -m homeassistant --script check_config --config /config
```

Run the existing browser checks against this container, without the release
gate's venv lifecycle management:

```sh
cd dev/gate
npm ci --no-audit --no-fund
npx playwright install chromium webkit
cd ../..
bash dev/container/check-browser.sh
node dev/container/smoke.mjs
```

The browser runner seeds upstream fixtures, runs cards, roundtrip, actions, and
visual checks, then removes the seeded fixtures. Results are written to `.gate/`.
It changes only the disposable HA configuration. New visual screenshots without
a baseline are reported as new; this is not a release gate certification.
Preserve any baseline failures when adapting these tests for viewing mode.
See [baseline-results.md](baseline-results.md) for the first completed run.

Stop the test instance without deleting its configuration:

```sh
docker compose -f dev/container/compose.yaml down
```

For a fresh instance, stop it and move `dev/container/runtime/` aside before
starting again. Do not reuse this setup with production configuration or devices.
