# Design Document

## Overview

Haunted Lab is one pnpm workspace with four tiny HTTP services, a shared `lab-common` package, and a supervisor. The supervisor runs each service as a child process from a git worktree, so a deploy is "check out a ref, start it, write a record". The chaos controller changes which ref a service runs. Because the three planted commits sit on `scenario/*` branches, the Exorcist can read the same commit through the diff API that the supervisor deployed.

Key decisions:

- Plain `node:http`. No framework keeps the culprit diffs a few lines long.
- Node 26 runs `.ts` directly (type stripping). Source uses erasable syntax only (no enums, no parameter properties, no namespaces). A worktree needs no build step.
- A worktree has no `node_modules`. The supervisor symlinks `<worktree>/node_modules`, `<worktree>/services/<svc>/node_modules` and `<worktree>/packages/lab-common/node_modules` to the primary checkout. Planted commits never touch dependencies, so this is safe. Node resolves symlinks to real paths, so `lab-common` (exported as `./src/index.ts`) is loaded from the primary checkout, outside any `node_modules` path, where type stripping is allowed. Task 1.3 confirms this on Node 26.7 and records the outcome in Notes.
- Rejected: per-worktree `pnpm install` (slow, needs the store), compiling to `dist` per worktree (extra step, diff vs run mismatch), Docker per service (slower restarts, a daemon on the crash loop path).
- Errors and logs are served by the supervisor so that a crash-looping service still has evidence. The supervisor captures child stdout/stderr (last 500 lines per service, kept across restarts), polls `/debug/errors` of running services on demand, and adds its own exit events.
- Prometheus reaches services through target files. On the Mac, containers cannot reach the host loopback, so `SERVICE_BIND_HOST` is set to an address the colima VM can reach (documented in `docs/DEV.md`). On EC2, `podman compose` with host networking keeps `127.0.0.1`. The services only expose synthetic metrics and rings, never secrets. Task 9.3 verifies this on the Mac.

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
- `callJson(url, body, { requestId, timeoutMs: 3000 })`: downstream client.

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

- payments keeps a synthetic refund table keyed by the last digit of the order id. `findRefund(orderId)` returns the record or `undefined`. A guard `if (!refund) return defaultTerms;` handles the `undefined` case. About 30 percent of ids have no record, so the guard matters.
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

### Supervisor modules

- `config.ts`: reads env, validates `CHAOS_TOKEN` (at least 16 chars) and `LAB_READ_TOKEN`, ports, `TRAFFIC_RPS`.
- `refs.ts`: `Allow_List`, `classifyRef(ref)` -> `allowed | reserved | denied`.
- `git.ts`: `execFile('git', [...args])` wrappers: `revParse(ref)`, `worktreeAdd(dir, sha)`, `isReachable(sha)`, `showCommit(sha)`.
- `worktrees.ts`: ensures `worktrees/<service>@<sha>` and the node_modules links.
- `runner.ts`: `ServiceRunner` per service: spawn, capture output, restart with `nextDelay(failures)`, stop.
- `deploys.ts`: `DeployLog` with `append(record)`, `readAll()`, `nextId()`.
- `chaos.ts`, `lab.ts`: route handlers. `server.ts`: wiring, auth, body limit, mutex.
- `traffic.ts`: `TrafficGenerator` with `nextInterval(rps, rand)`, in-flight cap.

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

Storage: Deploy_Log is JSON Lines, append only (`fs.appendFile` with `flag: 'a'`). Supervisor holds per-service output buffers (500 lines) in memory. Services hold the rings in memory. Nothing else is persisted.

Backoff: `nextDelay(consecutiveFailures) = min(30000, 500 * 2^(failures-1))`; stable for 60 s resets `failures` to 0.

Planted commit identity (constants in the Plant_Script): author and committer name `Haunted Lab Bot`, email `lab@example.invalid`, dates fixed ISO strings (one per branch, all after the `main` commit date), messages fixed. A planted SHA depends on its parent, so the SHAs are stable for a given `main` tip. `scripts/scenario-shas.json` records `{ base, shas }`: the `main` SHA the commits were planted on and the three resulting SHAs. The Plant_Script plants on the current `main` tip and rewrites that file; it never moves `main`. Two tests guard this: a fixture-repo test with hard-coded SHAs (proves determinism on any machine, independent of the lab's own history) and a real-repo test that fails with a clear message when `main` moved and `scenario-shas.json` is stale. Changing any file on `main` therefore means re-planting and updating the file together.

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
For any list of items and any diff text, the capped output is at most 256 KiB (lists) or 64 KiB (diff), is a prefix-preserving cut that stays valid JSON, and `truncated` is true iff something was cut.
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
- SIGTERM: stop children (SIGTERM, then SIGKILL after 5 s), close servers, exit 0.

## Testing Strategy

- Unit tests (Vitest, no network beyond loopback, no Docker): `parseEnv`, `Ring`, `sanitizeRequestId`, `readJsonBody`, route handlers with a fake downstream, `classifyRef`, `DeployLog`, `nextDelay`, query parser, size capper, traffic interval.
- Property tests (fast-check 4.10.2), one test per property above, each tagged `// Feature: haunted-lab, Property N`, at least 100 runs.
- Integration tests: (a) Plant_Script on a temporary clone, asserting the three SHAs, one commit on `main`, idempotence; (b) start the real Supervisor on random ports against a temporary clone with the planted branches, with `TRAFFIC_RPS=0`, and drive `/chaos` and `/lab`: apply `dark-room` and see crash-loop state and exit errors, apply `error-spike` and see errors from payments, reset and see all services on `main`, fetch a culprit diff by SHA, check 401/403/404/413/405 paths.
- Gate G1 (`scripts/g1-check.mjs`): the end-to-end check with Prometheus. Needs a container runtime, so it is not part of `pnpm test`; it is run by hand and by the orchestrator.
- Verification at the end: `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` exit 0.
