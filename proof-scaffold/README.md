# Proof scaffold for PR #140663 (matrix msgtype prototype keys)

CI-only test scaffolding for the exact-head before/after proof in
`.github/workflows/proof-matrix-msgtype-gateway.yml`. The workflow copies these
files into an immutable `openclaw/openclaw` checkout (never committed there) and
applies `scenario-flow-runner.patch` so the qa-lab Matrix live lane can run the
`matrix-proto-msgtype-reply-context` scenario:

- `scenario-runtime-proto-msgtype.ts` →
  `extensions/qa-lab/src/live-transports/matrix/scenarios/scenario-runtime-proto-msgtype.ts`
  Sends hostile `msgtype` room events to the disposable homeserver, lets the
  SUT gateway ingest them via the normal sync monitor path, and asserts on the
  agent transcript (`sessions.list` + `chat.history`) that prototype-named
  msgtypes stay plain text in reply context while a control `m.image` keeps its
  attachment marker.
- `matrix-proto-msgtype-reply-context.yaml` → `qa/scenarios/channels/`
- `scenario-flow-runner.patch` registers the scenario module import in
  `extensions/qa-lab/src/scenario-flow-runner.ts`.
