# Design Document

## Overview

Haunted Lab is one pnpm workspace with four tiny HTTP services, a shared `lab-common` package, and a supervisor. The supervisor runs each service as a child process from a git worktree, so a deploy is "check out a ref, start it, write a record". The chaos controller changes which ref a service runs. Because the three planted commits sit on `scenario/*` branches, the Exorcist can read the same commit through the diff API that the supervisor deployed.

Key decisions:

- Plain `node:http`. No framework keeps the culprit diffs a few lines long.
- Node 26 runs `.ts` directly (type stripping). Source uses erasable syntax only (no enums, no parameter properties, no namespaces). A worktree needs no build step.
- A worktree has no `node_modules`. The supervisor symlinks `<worktree>/services/<svc>/node_modules` to the installed one in the primary checkout. Planted commits never touch dependencies, so this is safe. Node resolves symlinks to real paths, so `lab-common` (exported as `./src/index.ts`) and `prom-client` load from the primary checkout, outside any `node_modules` path, where type stripping is allowed. Confirmed on Node 26.7 (task 1.3). Consequence: a commit that changes `packages/lab-common` takes effect only in the primary checkout, not in a worktree.
- Rejected: per-worktree `pnpm install` (slow, needs the store), compiling to `dist` per worktree (extra step, diff vs run mismatch), Docker per service (slower restarts, a daemon on the crash loop path).
- Errors and logs are served by the supervisor so that a crash-looping service still has evidence. The supervisor captures child stdout/stderr (last 500 lines per service, kept across restarts), polls `/debug/errors` of running services on demand, and adds its own exit events.
- Prometheus reaches services through file-based targets (`deploy/targets/lab.json`) as `lab-host:<port>`, where `lab-host` maps to the container's host gateway. On colima a container reaches the Mac's `127.0.0.1` through `host-gateway`, so the services stay on loopback (verified, task 9.3). On a Linux host (EC2) the host gateway is a bridge address, which would force the services onto `0.0.0.0`; instead `deploy/compose.linux.yaml` runs Prometheus with `network_mode: host`, no published ports, `--web.listen-address=127.0.0.1:9090` and `lab-host` = `127.0.0.1`, so the services stay on `127.0.0.1` (merged config checked with `docker-compose config`; not run on EC2 yet). G1 adds the override on Linux. The services only expose synthetic metrics and rings, never secrets.
- Service-to-service calls and the traffic generator use `node:http` with a keep-alive agent, not `fetch`: on the dev Mac, undici adds about 300 ms when it reuses an idle keep-alive socket, which would blur the latency signal and break the p95 baseline.
- Until the services are committed to `main`, the lab runs from a deterministic snapshot repo (`scripts/build-lab-repo.mjs`): one commit holding the runtime files only, with a fixed identity and date, and the three scenarios planted on it. Tests and Gate G1 use it; `LAB_REPO_DIR` points the supervisor at it.

## Architecture

```mermaid
flowchart LR
  subgraph Host["Host (127.0.0.1)"]
    TG[Traffic generator]
    SUP[Supervisor :4100]
    GATE[gate :4001] --> ORD[orders :4002] --> PAY[payments :4003] --> LED[ledger :4004]
    GIT[(git repo: main, scenario/*)]
    WT[(worktrees/service@sha)]
    DL[(data/deploys.jsonl)]
  end
  PROM[Prometheus :9090 on 127.0.0.1]
  API[Haunted Ops api]
  TG -->|POST /checkout| GATE
  SUP -->|execFile git worktree add| GIT
  GIT --> WT
  SUP -->|spawn node src/main.ts| GATE
  SUP --> ORD
  SUP --> PAY
  SUP --> LED
  SUP -->|append| DL
  PROM -->|scrape /metrics every 5s| GATE
  PROM --> ORD
  PROM --> PAY
  PROM --> LED
  API -->|/chaos Bearer CHAOS_TOKEN| SUP
  API -->|/lab Bearer LAB_READ_TOKEN| SUP
  API -->|PromQL| PROM
```

Deploy flow: `apply fog` -> check `fog` is in the scenario table -> resolve `scenario/fog` to a SHA with `git rev-parse` -> ensure `worktrees/orders@<sha>` exists (`git worktree add --detach`) -> link node_modules -> stop the old `orders` child -> start the new one -> append a Deploy_Record -> respond. The other three services stay on `main` (already running; only a service whose ref or sha changes is restarted).

## Components and Interfaces

All responses are JSON unless noted. Errors use `{"error":{"code":"<code>","message":"<text>"}}`. Request bodies are limited to 8 KiB (413 `payload_too_large`). Ports come from env with defaults: gate 4001, orders 4002, payments 4003, ledger 4004, supervisor 4100.

### packages/lab-common (`@haunted-lab/common`)

- `parseEnv(spec, env)`: returns typed config or `ConfigError` listing NAMES only.
- `Ring<T>(capacity)`: `push`, `latest(limit)` (oldest first), `size`.
- `createMetrics()`: registry with `http_requests_total{route,code}` and `http_request_duration_seconds` (buckets 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10).
- `createServer({ routes, metrics, errors, logs, name })`: wraps `node:http`; matches route templates, enforces the body limit, records metrics for non-infra routes, assigns request ids, converts thrown errors to 500 and an Error_Ring entry, serves `/healthz`, `/metrics`, `/debug/errors`, `/debug/logs`.
- `readJsonBody(req, limit)`: reads up to the limit, then rejects.
- `sanitizeRequestId(value)`: returns the value if it matches `^[A-Za-z0-9_-]{1,64}$`, else a new id.
- `bearerMatches(header, secret)`: constant time (SHA-256 both sides, then `timingSafeEqual`).
- `httpRequest(url, opts)`: small `node:http` client (keep-alive agent, timeout, 1 MiB response cap).
- `callJson(url, body, { requestId, timeoutMs: 3000 })`: downstream POST; any failure, non-2xx or timeout becomes 502 `bad_gateway`.
- `readRawBody` / `ctx.discardBody()`: bounded body read for routes that ignore the body (chaos POSTs).

### Service routes

| Service | Method and route | Request | Response |
| --- | --- | --- | --- |
| gate | `POST /checkout` | `{ "orderId": string(1..32), "sku": string(1..32), "qty": int 1..9, "amountCents": int 1..1000000 }` | 200 `{ orderId, paymentId, ledgerEntryId, status: "confirmed" }`; 400; 413; 502 |
| orders | `POST /orders` | same as checkout | 200 `{ orderId, paymentId, ledgerEntryId, reserved: true }`; 400; 502 |
| payments | `POST /payments/charge` | `{ orderId, amountCents }` | 200 `{ paymentId, ledgerEntryId, status: "captured" }`; 400; 500; 502 |
| ledger | `POST /ledger/entries` | `{ orderId, paymentId, amountCents }` | 201 `{ entryId }`; 400 |
| all | `GET /healthz` | none | 200 `{ "ok": true }` |
| all | `GET /metrics` | none | 200 `text/plain; version=0.0.4` |
| all | `GET /debug/errors?limit=n` | `limit` 1..200, default 50 | 200 `{ items: [{ time, message, frame, requestId }] }` |
| all | `GET /debug/logs?limit=n` | `limit` 1..500, default 100 | 200 `{ items: [{ time, line }] }` |

Service env: `<SERVICE>_PORT` (required), `SERVICE_BIND_HOST` (default `127.0.0.1`), `ORDERS_URL` (gate), `PAYMENTS_URL` (orders), `LEDGER_URL` (payments). A missing required name exits 1 with `missing required env: <NAME>` on stderr.

Healthy behaviour on `main` (fixed so the culprit diffs are small):

- payments keeps a synthetic refund table keyed by the character sum of the order id modulo 10 (buckets 7 to 9 have no record). `findRefund(orderId)` returns the record or `undefined`. A guard `if (!refund) return DEFAULT_TERMS;` handles the `undefined` case. About 30 percent of ids have no record, so the guard matters.
- orders `reserveStock(sku)` completes in about 20 ms (a short simulated delay).
- ledger reads `LEDGER_PORT` in `loadConfig()`.

### Scenario table (constant in `supervisor/src/scenarios.ts`)

| Name | Service | Ref | Commit title | Effect |
| --- | --- | --- | --- | --- |
| `error-spike` | payments | `scenario/error-spike` | simplify refund lookup | removes the `undefined` guard; about 30 percent of charges throw `TypeError`, answered 500 |
| `fog` | orders | `scenario/fog` | add inventory freshness check | 8 sequential simulated inventory calls of about 200 ms; p95 above 1.5 s; no errors |
| `dark-room` | ledger | `scenario/dark-room` | tidy config loading | reads `LEDGER_LISTEN_PORT` (not set); exits 1 at start; crash loop; `up` 0 |

### Supervisor HTTP (`127.0.0.1:4100`)

Unauthenticated: `GET /healthz` -> 200 `{ "ok": true }`.

Chaos (Bearer `CHAOS_TOKEN`):

| Route | Request | Response |
| --- | --- | --- |
| `POST /chaos/scenarios/{name}/apply` | body ignored (max 8 KiB) | 200 `{ scenario, deploys: [Deploy_Record], state }`; 401; 404 `unknown_scenario`; 403 `ref_reserved`; 413; 500 `deploy_failed` |
| `POST /chaos/reset` | body ignored | 200 `{ deploys: [Deploy_Record], state }` (only services that changed get a record) |
| `GET /chaos/state` | none | 200 `State` (below) |

Observability (Bearer `LAB_READ_TOKEN`, GET only):

| Route | Query | Response |
| --- | --- | --- |
| `GET /lab/errors` | `service` (one of the four), `since` (ISO-8601), `limit` (1..500, default 100) | 200 `{ items: [ErrorItem], truncated }` |
| `GET /lab/logs` | same | 200 `{ items: [LogItem], truncated }` |
| `GET /lab/deploys` | `since` | 200 `{ items: [Deploy_Record], truncated }` |
| `GET /lab/commits/{sha}/diff` | none | 200 `{ sha, subject, author, date, diff, truncated, bytes }`; 404 `unknown_commit` |

Common errors: 400 `bad_request`, 401 `unauthorized` (with `www-authenticate: Bearer`), 405 `method_not_allowed`, 404 `not_found`, 413 `payload_too_large`.

Every `/lab/*` body, success or error, starts with `"untrusted": true` (lists: `{ untrusted, items, truncated }`; diff: `{ untrusted, sha, subject, author, date, diff, truncated, bytes }`; errors: `{ untrusted, error }`). `/chaos/*` bodies do not carry it.

### Untrusted data for the Exorcist

Everything `/lab` returns (error messages and frames, log lines, commit subjects, authors, refs and diffs) is produced by services, child processes or commits, any of which may be broken or hostile. It is untrusted input for the Exorcist and must never be treated as instructions: the agent quotes it as evidence and decides only from its own instructions. The supervisor reduces what such text can do before it leaves the host (`supervisor/src/untrusted.ts`):

- Bound first: each value is cut to 4x its cap before any regex runs, then cut to the cap: `message` 500, `line` 2000, `frame` 300, `subject` 300, `author` 200, `ref` 200, `requestId` 64 characters; `diff` 64 KiB.
- Remove ANSI escapes (CSI, OSC, two-character ESC sequences, 8-bit CSI) and C0/C1 control characters and DEL. Single-line fields turn them into spaces; a diff keeps line feeds and tabs only.
- Strip every local absolute path: a path into `services/` or `packages/` becomes repo-relative, a path through `node_modules/` becomes `node_modules/<pkg>/...`, any other filesystem path (home, temp, `/opt`, `file://`, or anything ending in a source extension) keeps only its file name. Route-like strings (`/checkout`) are left alone.
- Diffs only cover `-- services packages`.
- Mark the body `untrusted: true`.


### Supervisor modules

- `config.ts`: reads env, validates `CHAOS_TOKEN` and `LAB_READ_TOKEN` (at least 16 chars each, not starting with the `.env.example` placeholder prefix `change-me`, and different from each other; errors name variables only), ports, `TRAFFIC_RPS`.
- `refs.ts`: `Allow_List`, `classifyRef(ref)` -> `allowed | reserved | denied`.
- `git.ts`: `execFile('git', [...args])` / `spawn` wrappers with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, no `HOME`, no prompts, and a 30 s timeout (SIGKILL) on every call including the streamed `git show` of `commitDiff`.
- `worktrees.ts`: ensures `worktrees/<service>@<sha>` and the node_modules link; `removeWorktree` (`git worktree remove --force`, falling back to deleting our own dir, then `git worktree prune`) and `cleanWorktrees` only ever touch `<service>@<40-hex>` entries directly inside the worktrees dir. At start every worktree is removed (no child runs yet); after each Deploy the previous worktree of that service is removed once its child stopped (`Lab` dependency `retire`). Only the active worktree per service remains.
- `runner.ts`: `ServiceRunner` per service: spawn (`node src/main.ts --lab-service=<name>`, `detached: true`, so each child leads its own process group), capture output, restart with `nextDelay(failures)`, stop by signalling the group (SIGTERM, then SIGKILL after 5 s).
- `pids.ts`: `PidFile` keeps `data/pids.json` (`{ service: pid }`, atomic tmp+rename writes). At start, before any deploy binds a port, `killStale` signals each recorded group only if `ps -o command=` shows `src/main.ts` and the matching `--lab-service=<name>` marker, so a pid reused by another program is never touched. This covers a supervisor that died by SIGKILL.
- `deploys.ts`: `DeployLog` with `append(record)` and `records()`. The file is read once at `open` (next id = highest + 1); a bounded in-memory tail (1000 records) is appended on each write and serves `/lab/deploys`, so requests never re-read the file.
- `chaos.ts`: the `Lab` controller (boot, apply, reset, state, mutex). `observability.ts`: query parser, size caps, `/lab` handlers, cleaning every untrusted field (see above). `server.ts`: routes, auth per prefix, body limit. `app.ts`: wiring. `worktrees.ts`, `git.ts`: worktrees and git through `execFile`/`spawn` argument arrays.
- `traffic.ts`: `TrafficGenerator` with `nextInterval(rps, rand)`, in-flight cap.

### Pinned versions

Checked against the registry on 2026-11-13.

| Component | Version | Note |
| --- | --- | --- |
| Node | 26 (`.nvmrc`), tested on 26.7.0 | type stripping runs the `.ts` sources directly |
| pnpm | 11.7.0 | `packageManager` |
| `prom-client` | 15.1.3 | latest; the registry marks it deprecated in favour of `@prometheus-io/client`; kept as the spec asks |
| Prometheus image | `prom/prometheus:v3.16.0` | latest stable tag on Docker Hub (2026-11-05); never `latest` |
| TypeScript | `typescript@7.0.2` as `@typescript/native` (tsc), `@typescript/typescript6@6.0.2` as `typescript` (tooling API) | same aliasing as Haunted Ops |
| `vitest` | 5.1.0 | |
| `fast-check` | 4.10.2 | |
| `eslint` / `typescript-eslint` / `@eslint/js` / `globals` | 10.14.0 / 8.72.2 / 10.0.1 / 17.14.0 | |
| `@types/node` | 26.6.6 | |

## Data Models

```ts
type ServiceName = 'gate' | 'orders' | 'payments' | 'ledger';
type ScenarioName = 'error-spike' | 'fog' | 'dark-room';

interface DeployRecord {      // one JSON line in data/deploys.jsonl
  id: string;                 // 'd-101', 'd-102', ...
  service: ServiceName;
  ref: string;                // allow-listed ref
  sha: string;                // 40-char commit sha
  time: string;               // ISO-8601 UTC
  actor: 'supervisor' | 'chaos' | 'exorcist';  // 'exorcist' reserved
}

interface ServiceState {
  service: ServiceName;
  ref: string;
  sha: string;
  status: 'starting' | 'running' | 'backoff' | 'stopped';
  restarts: number;
  since: string;              // ISO-8601, start of current process or backoff
  lastExit?: { code: number | null; signal: string | null; time: string };
}

interface State { activeScenario: ScenarioName | null; services: ServiceState[]; }

interface ErrorItem {
  time: string; service: ServiceName; message: string;
  frame: string;              // first stack frame or ''
  requestId: string;          // '' when unknown
  source: 'service' | 'supervisor';
}
interface LogItem { time: string; service: ServiceName; stream: 'stdout' | 'stderr'; line: string; }
```

Storage: Deploy_Log is JSON Lines, append only (`fs.appendFile` with `flag: 'a'`). `data/pids.json` holds the live child pids. Supervisor holds per-service output buffers (500 lines) and the deploy tail in memory. Services hold the rings in memory. Nothing else is persisted.

Metrics: each service creates `http_requests_total{route,code}` at 0 for codes `200` and `500` on every own route at start, so on a healthy `main` the error ratio is 0, not an empty vector. Consumers (the Haunted Ops `ingest-haunt-score`) should still write ratios as `(sum(rate(...{code=~"5.."}[w])) or vector(0)) / sum(rate(...[w]))` (a restarted process has no 5xx series until it is scraped, other codes appear lazily) and read `up` through `avg_over_time(up[w])` rather than a single sample, because a redeploy restarts the process and can blip one scrape.

Repo choice: by default the supervisor deploys from the live checkout (`LAB_REPO_DIR` defaults to it), not a dedicated clone. The scenario branches and, later, the Exorcist's `exorcist/*` fix branches are refs of this repo, and the diff API must show exactly those commits; a clone under `data/` would need a fetch step that can drift. The supervisor never touches the checkout's working tree, index or branches: it only resolves allow-listed refs, adds detached worktrees under `worktrees/` and removes its own ones. Tests and G1 point `LAB_REPO_DIR` at a temporary snapshot repo instead.

Backoff: `nextDelay(consecutiveFailures) = min(30000, 500 * 2^(failures-1))`; stable for 60 s resets `failures` to 0.

Planted commit identity (constants in the Plant_Script): author and committer name `Haunted Lab Bot`, email `lab@example.invalid`, fixed messages. Author and committer date = the base commit's committer date + 1 h (`error-spike`), + 2 h (`fog`), + 3 h (`dark-room`), written as `@<unix> +0000`: deterministic for a given base and always newer than the real parent. A planted SHA depends on its parent, so the SHAs are stable for a given `main` tip. The snapshot repo (`build-lab-repo.mjs`) has its own fixed `main` date (`2026-11-01T00:00:00Z`), so its four SHAs are fully fixed and asserted exactly in `supervisor/test/plant.test.ts`. For this repo, `scripts/scenario-shas.json` records `{ base, shas }`. Committing that file moves `main`, so the check (`verifyPlantRecord`) does not require `main === base`; it requires each scenario branch to be exactly one commit whose parent is `base`, `base` to be an ancestor of `main`, and the branch SHAs to equal the record. A rewritten `main` that no longer contains `base`, or a re-planted branch, fails it.

## Correctness Properties

### Property 1: Rings stay bounded and ordered
For any sequence of pushes into a ring of capacity N, the ring holds at most N entries, they are the last N pushed in push order, and `latest(limit)` returns at most `limit` of them, oldest first.
**Validates: Requirements 4.1, 4.2, 4.3, 4.4**

### Property 2: Route labels are bounded
For any request path and method, the `route` label is either one of the registered route templates or `unmatched`, and requests to `/metrics`, `/healthz` and `/debug/*` add nothing to `http_requests_total`.
**Validates: Requirements 3.4, 3.6**

### Property 3: Bearer comparison is exact
For any configured secret and any Authorization header, `bearerMatches` is true if and only if the header is `Bearer ` followed by exactly the secret. The `CHAOS_TOKEN` is never accepted on `/lab` routes and the `LAB_READ_TOKEN` is never accepted on `/chaos` routes. Unauthorized responses contain neither secret.
**Validates: Requirements 7.1, 8.1, 8.2**

### Property 4: Only allow-listed refs deploy
For any string, `classifyRef` returns `allowed` iff it is one of `main`, `scenario/error-spike`, `scenario/fog`, `scenario/dark-room`; returns `reserved` iff it matches `exorcist/*` and is not allowed; returns `denied` otherwise. The deploy function refuses `reserved` and `denied` without calling git.
**Validates: Requirements 6.1, 7.7, 7.8**

### Property 5: Deploy ids are unique, increasing and survive restart
For any sequence of appended Deploy_Records and any restart point, ids are unique and strictly increasing starting at `d-101`, the log only grows, and a new `DeployLog` over the same file continues from the highest id. Every line parses back to the same record.
**Validates: Requirements 6.6, 6.7, 6.8**

### Property 6: Backoff is monotone, capped and resettable
For any number of consecutive failures, `nextDelay` starts at 500 ms, never decreases, never exceeds 30 000 ms, and returns 500 ms after a stable run of 60 s.
**Validates: Requirements 6.4, 6.5**

### Property 7: Query parameters are validated totally
For any `service`, `since` and `limit` values, the parser returns either a valid query (`service` in the four names, `since` a valid ISO-8601 instant, `limit` an integer in 1..500, default 100) or a `bad_request` error, and never throws.
**Validates: Requirements 8.9**

### Property 8: Response size caps hold
For any list of items and any diff text, the capped output is at most 256 KiB (lists) or 64 KiB (diff), stays valid JSON, and `truncated` is true iff something was cut. A diff is cut to a byte prefix on a UTF-8 character boundary; a list keeps its newest items, in order.
**Validates: Requirements 8.8**

### Property 9: Diffs are served only for reachable commits
For any commit graph, branch set and requested string, the diff route serves a commit iff the string is a 7 to 40 character hex string that resolves to a commit reachable from an allow-listed ref. Anything else is `unknown_commit`.
**Validates: Requirements 8.6, 8.7**

### Property 10: Body limit is exact
For any body length L, a body of at most 8 192 bytes is accepted and a longer one is answered 413 after reading no more than the limit plus one chunk.
**Validates: Requirements 2.5, 7.9**

### Property 11: Planting is deterministic and idempotent
Running the Plant_Script once or many times on a clean clone of `main` yields the same three SHAs, each branch has exactly one commit on `main`, and the expected SHAs recorded in the test match.
**Validates: Requirements 9.1, 9.2, 9.3, 9.7**

### Property 12: Traffic jitter stays within bounds
For any `rps` in 1..50 and any random source in [0,1), `nextInterval` lies within 60 to 140 percent of `1000/rps` ms, and the mean over many samples is within 5 percent of the base.
**Validates: Requirements 5.2**

### Property 13: Env values never leave the process
For any generated env (names and values), the config errors, logs, ring entries and API responses never contain an env value, and a child env contains only the fixed list of names and never `CHAOS_TOKEN` or `LAB_READ_TOKEN`.
**Validates: Requirements 2.7, 4.7, 6.3, 8.10**

### Property 14: Apply and reset converge
For any sequence of apply and reset calls against a fake runner, the state after each call is: the target Service on its Scenario_Branch and all others on `main` for `apply`, and all Services on `main` with no active Scenario for `reset`. Only Services whose ref changed get a Deploy_Record.
**Validates: Requirements 7.3, 7.5, 6.6**

### Property 15: Request ids are sanitised
For any incoming `x-request-id` value, the id used is the value if it matches `^[A-Za-z0-9_-]{1,64}$` and a fresh valid id otherwise.
**Validates: Requirements 4.5**

### Property 16: In-flight requests never exceed the cap
For any request latency pattern, the Traffic_Generator never has more than 50 requests in flight and never queues a skipped tick.
**Validates: Requirements 5.3**

### Property 17: Untrusted text is bounded, control-free and path-free
For any input string and any untrusted single-line field, the cleaned value is at most the field's cap, contains no C0/C1 control character, DEL or ANSI escape, and contains no local absolute path from a home or temp root, whatever text surrounds it.
**Validates: Requirements 8.12, 8.13**

## Error Handling

- Unknown route 404 `not_found`; wrong method on a known route 405 with an `allow` header.
- Malformed JSON or failed validation 400 `bad_request` (not an Error_Ring entry). Oversize body 413 `payload_too_large`.
- Downstream failure or 3 s timeout: 502 `bad_gateway`, one Error_Ring entry. Uncaught handler error: 500 `internal_error`, one Error_Ring entry with the first stack frame; the stack is never sent to the client.
- Config error: print `missing required env: <NAME>` or `invalid env: <NAME>`, exit 1, before `listen`.
- Supervisor deploy failure (git error, missing ref): 500 `deploy_failed` with a generic message; details go to the supervisor log without env values. A failed deploy keeps the previous child running.
- Child crash: exit event stored as a supervisor-source error item, restart with backoff.
- Reserved ref: 403 `ref_reserved`. Unknown scenario: 404 `unknown_scenario`.
- Auth failure: 401 with no hint which token was expected; tokens are never logged.
- Prometheus or compose unavailable: Gate_G1 exits 1 with the failing step named.
- SIGTERM: stop children (SIGTERM, then SIGKILL after 5 s, to the whole process group), close servers, exit 0.
- SIGKILL of the supervisor: children survive in their own groups; the next start stops them from `data/pids.json` (command line checked) before deploying.
- Placeholder, short or shared tokens: startup error naming the variables (`invalid env: CHAOS_TOKEN`, `CHAOS_TOKEN and LAB_READ_TOKEN must be different`), exit 1, no value printed.
- git hang: every call is killed after 30 s and reported as a generic git error (`deploy_failed` or 500).

## Testing Strategy

- Unit tests (Vitest, no network beyond loopback, no Docker): `parseEnv`, `Ring`, `sanitizeRequestId`, `readJsonBody`, route handlers with a fake downstream, `classifyRef`, `DeployLog`, `nextDelay`, query parser, size capper, traffic interval.
- Property tests (fast-check 4.10.2), one test per property above, each tagged `// Feature: haunted-lab, Property N`, at least 100 runs, except the git-backed ones (Properties 9 and 11), which spawn git on every run and use fewer runs plus fixed edge cases.
- Integration tests: (a) Plant_Script on a temporary clone, asserting the three SHAs, one commit on `main`, idempotence; (b) start the real Supervisor on random ports against a temporary clone with the planted branches, with `TRAFFIC_RPS=0`, and drive `/chaos` and `/lab`: apply `dark-room` and see crash-loop state and exit errors, apply `error-spike` and see errors from payments, reset and see all services on `main`, fetch a culprit diff by SHA, check 401/403/404/413/405 paths.
- Service route tests per service with fake downstreams, and one in-process test per scenario: `scripts/scenario-copy.mjs` copies the service `src/` with the planted patch next to the service; `error-spike` gives a 500 ratio between 0.25 and 0.35 over 400 seeded order ids, `fog` adds 8 x 200 ms on a fake clock, `dark-room` exits 1 with `missing required env: LEDGER_LISTEN_PORT`. Tests use seeded RNGs and fake clocks, no wall-clock thresholds below 150 ms.
- Supervisor hardening tests: process groups and stale-pid cleanup (including a real SIGKILL of the supervisor in the integration test), worktree cleanup, git isolation and timeout, diff pathspec, untrusted marker and field cleaning (Property 17), deploy tail, token rules, compose files.
- Gate G1 (`scripts/g1-check.mjs`): the end-to-end check with Prometheus. Needs a container runtime, so it is not part of `pnpm test`; it is run by hand and by the orchestrator.
- Verification at the end: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` exit 0.
