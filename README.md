# FlowOps — an n8n-style workflow automation platform

A production-grade clone of [n8n](https://n8n.io): a node-based workflow editor with a
DAG execution engine, live webhooks, cron scheduling, AI/LLM nodes, encrypted credential
storage, and full execution history with replay.

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  web/  React + React Flow   │  HTTP  │  server/  Express + DAG engine   │
│  canvas · inspector · logs  │ ─────► │  Postgres-ready · Redis-ready    │
└─────────────────────────────┘        └──────────────────────────────────┘
```

## Demo recording

![FlowOps editor recording](docs/morning-brief-demo.mp4)

`docs/morning-brief-demo.mp4` — the editor running the **Morning Email Brief** workflow
end to end: searching the node palette, executing the graph, inspecting the drafted email
and the send result, then activating the schedule. Recorded headlessly from the real UI
(`1280×800 @1.5×`), no mockups. The drafted email itself is rendered in
`docs/morning-brief-email.html`.

## Quick start (zero external dependencies)

```bash
npm install
npm run dev:server     # API on http://localhost:5175
npm run dev:web        # Editor on http://localhost:5173 (proxies /api + /webhook)
```

With no environment variables set, the server runs on an **in-memory store persisted to
`server/data/memory-store.json`** and an **in-process job queue with retry + exponential
backoff** — everything works out of the box.

## Production configuration

| Env var          | Effect                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| `DATABASE_URL`   | PostgreSQL connection string. Schema (`server/db/schema.sql`) is applied automatically on boot. |
| `REDIS_URL`      | Enables **Redis + BullMQ** for webhook executions (3 attempts, exponential backoff). |
| `ENCRYPTION_KEY` | Key material for AES-256-GCM credential encryption (defaults to a derived dev key with a warning). |
| `PORT`           | API port (default `5175`).                                                |
| `DATA_FILE`      | Memory-store persistence path (default `data/memory-store.json`).         |

```bash
npm run build          # tsc (server) + vite build (web)
npm start              # node server/dist/index.js
```

## What's implemented

### Execution engine (`server/src/engine/`)
- **DAG traversal** — parses nodes + connections, standardizes data as
  `[{ json, binary }]` items, delivers each edge exactly once, and closes the graph by
  propagating empty payloads to dead branches (downstream nodes are marked `skipped`).
- **Branch routing** — IF/Switch deliver only to the outputs that matched.
- **Expression sandbox** (`expression.ts`) — hand-written Pratt parser for
  `{{ $json.body.email }}`-style expressions: member/index access, ternary, comparisons,
  whitelisted globals; `__proto__`/`constructor`/`prototype` access is blocked.
  Method calls keep their receiver (`{{ $json.name.toUpperCase() }}`). `$now` is the ISO
  timestamp with date helpers: `{{ $now.format('dddd, MMMM D') }}`,
  `{{ $now.plus(1, 'day').format('YYYY-MM-DD') }}`, `$now.weekday` (tokens: YYYY YY MMMM MMM
  MM M dddd ddd DD D HH H hh h mm ss A a, `[literal text]`).
- **Unconnected nodes** — runs start from trigger nodes; any node not wired to a trigger is
  reported as `skipped` with a "Not connected" message instead of running on its own.
- **Code node** — custom JavaScript in `node:vm` (5 s timeout, `codeGeneration` disabled,
  structured-cloned inputs). *Tradeoff: `node:vm` is an isolation boundary, not a security
  hardening — swap in `isolated-vm` for hostile multi-tenant workloads.*

### Nodes
| Category | Nodes |
| --- | --- |
| **Triggers** | Webhook (HMAC-SHA256 validation), Schedule (cron), Manual |
| **Core Logic** | IF, Switch (rule-based, dynamic outputs), Merge (append/combine), Loop Over Items (batching), Wait, Code (JavaScript) |
| **AI & Agents** | AI Agent, LLM Chain, OpenAI (OpenAI-compatible + Gemini APIs, plus a keyless `local` template provider) — Vector Store / Memory / Tool Calling are beta stubs |
| **App Integrations** | HTTP Request (header-auth credential), PostgreSQL, Slack (incoming webhook), Send Email (SMTP via nodemailer, writes RFC 822 `.eml` files to the outbox when no credential is attached) — Redis / Gmail beta stubs |

### Backend
- **REST API** (`server/src/api.ts`) — workflow CRUD, activate/deactivate, run, single-node
  test, executions list/detail/replay, credential CRUD.
- **Webhook routes** — `POST|GET|PUT /webhook/:workflowId/:path` (queued via BullMQ/inline)
  and `/webhook-test/...` (synchronous, returns last node output). When a webhook node has
  an `hmacSecret`, requests must send `X-Signature` = hex HMAC-SHA256 of the raw body
  (constant-time comparison).
- **Trigger manager** (`triggers.ts`) — registers/unregisters webhook routes and
  `node-cron` schedules on activate/deactivate/save, and re-registers all active workflows
  on boot.
- **Error workflows** — a failing workflow forwards `{ error, workflowId, executionId }`
  to the workflow named in `settings.errorWorkflow`.
- **Credentials** — AES-256-GCM at rest (`v1.iv.tag.ciphertext`); secrets never leave the
  server after creation.

### Frontend (`web/`)
- **Canvas** — React Flow: drag-and-drop from the node drawer, bezier edges, multi-handle
  IF (green/red true/false) and Switch nodes, node states (idle → running pulse → success
  with `ms` badge / error inline), `N item(s)` badges on wires, animated edges while
  running, tidy-up auto-layout, zoom controls.
- **Node drawer** — searchable slide-over grouped into Triggers / Core Logic / AI & Agents /
  App Integrations.
- **3-pane node inspector** — Input data (Tree/Table/Raw JSON views) · dynamic parameter
  forms with `{{ }}` expression highlighting + variable hints + credential selector ·
  Output data with per-node "Test Step".
- **Top bar** — editable title, Active/Inactive toggle (registers live triggers), tags,
  save. **Bottom bar** — Test Workflow, zoom, tidy-up, execution-logs drawer with
  one-click replay.
- Design tokens: `#18191C` canvas, `#232429` surfaces, `#FF6D5A` coral accent, crisp
  technical typography (see `web/src/index.css`).

## Verified end-to-end

- Manual run of a 5-node graph (Manual → Code → IF → HTTP/Wait): correct branching,
  item counts per edge, skipped dead branch.
- Production webhook: activate → `POST /webhook/:id/orders` → queued execution recorded
  (mode `production`); test-mode returns final node output synchronously.
- HMAC: `401 Invalid webhook signature` without/with wrong `X-Signature`; `200` with the
  valid HMAC-SHA256 of the raw body.
- UI: nodes placed & wired in the editor, Test Workflow run (HTTP node fetched
  `https://api.github.com/zen` in 701 ms), Test Step, credential creation (encrypted at
  rest), replay — zero console errors.
- `npm run build` clean for both workspaces.
- Morning brief automation: manual run produced a 5-node success trace (0–19 ms per node),
  an `.eml` in `server/data/outbox/` with RFC 2047-encoded headers, and a cron trigger
  registered as `0 8 * * *`.
- Execution history: `DELETE /api/executions/:id` removes a run from both stores.

## Try it

1. Open the editor, click **+ Node**, place a **Webhook**, then a **Code** node, wire them.
2. In the Code node use:
   ```js
   const payload = $input.first().json;
   return [{ json: { received: payload.body } }];
   ```
3. Toggle **Active** (top bar) — the webhook route registers live.
4. `curl -X POST http://localhost:5175/webhook/<workflowId>/<path> -d '{"hello":"world"}'`
5. Open the **logs drawer** (bottom bar) to inspect the run and replay it.

## Example automation: a morning email brief

`tests/morning-brief-workflow.json` is the workflow from the demo — import it with
`POST /api/workflows` (or recreate it in the UI):

```
Schedule (0 8 * * *) → Build Brief Data (Code) → Draft Email (AI Agent) → Compose Message (Code) → Send Email
```

- **Build Brief Data** collects the day's stats into one item (`to`, `dateLabel`,
  `highlights`, `focus`, `metrics`). Replace the static arrays with real sources — a
  Postgres query, an HTTP Request, a calendar API.
- **Draft Email** turns that item into prose. With an LLM credential attached it calls
  OpenAI/Gemini; with `provider = local` it renders a deterministic template draft so the
  workflow runs with no API key.
- **Compose Message** converts the draft into a subject + styled HTML body.
- **Send Email** delivers over SMTP using a `smtp` credential (host/port/user/password).
  Without a credential it writes a real `.eml` file to `server/data/outbox/` and reports
  `{ sent: false, transport: "outbox" }` — safe to run, easy to inspect in any mail client.

Activate the workflow and the `0 8 * * *` cron is registered with `node-cron`; the trigger
manager re-registers it on server boot. To send for real, create an **SMTP** credential
(app password for Gmail, API key for Postmark/Resend SMTP) and attach it to the node —
everything else stays the same.

## Architecture notes & roadmap

- Storage and queue are interface-based (`Store`, `JobQueue`) — Postgres/BullMQ drop in
  via env vars, memory/inline fallbacks keep local dev zero-config.
- `api.ts` `summarizeExecution` strips `nodeRuns` from list responses; full snapshots are
  on `GET /executions/:id`.
- Roadmap: workflow version history (top-bar button is a placeholder), OAuth2 Gmail node,
  real Vector Store/Memory/Tool nodes, isolated-vm code sandbox, per-node retry settings,
  fan-out parallel execution.

## Known limitations

- Beta nodes (Vector Store, Memory, Tool, Redis, Gmail) exist in the UI registry but throw
  "not implemented" server-side.
- The Code sandbox allows no async operations (by design, sync `vm` run); Wait maxes at 60 s.
- Webhook HMAC secrets live in the workflow graph (node parameters), not the encrypted
  credentials table.
