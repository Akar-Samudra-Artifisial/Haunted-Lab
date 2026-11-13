# Requirements Document

## Introduction

Haunted Lab is the second public repository of the Haunted Ops entry (Kiroween 2026). It is a small, synthetic system that we break on purpose so that the Exorcist agent in `haunted-ops` can investigate a fault and propose a fix as a pull request against this repository.

The lab has four services in one call chain, a traffic generator, a supervisor that runs each service from a git worktree, a chaos controller that applies three planted fault scenarios, a read-only observability API, and Prometheus. Each scenario is one planted culprit commit with a SHA that is identical on every machine. A Gate G1 script proves that every scenario moves the expected signal and that a reset recovers.

This spec covers the lab only. The Exorcist agent, the MCP tools that read the observability API, the Haunted Ops api and the scene are out of scope.

## Glossary

- **Lab**: this repository and the running system it produces.
- **Service**: one of `gate`, `orders`, `payments`, `ledger`. A Node 26 process using plain `node:http`.
- **Call_Chain**: `gate` calls `orders`, `orders` calls `payments`, `payments` calls `ledger`. `gate` is the entry.
- **Supervisor**: the process in `supervisor/` that runs services, serves the Chaos_Controller and the Observability_API, and runs the Traffic_Generator.
- **Traffic_Generator**: the component of the Supervisor that sends steady synthetic requests to `gate`.
- **Chaos_Controller**: the HTTP routes under `/chaos` on the Supervisor, protected by `CHAOS_TOKEN`.
- **Observability_API**: the read-only HTTP routes under `/lab` on the Supervisor, protected by `LAB_READ_TOKEN`.
- **Ref**: a git ref name such as `main` or `scenario/fog`.
- **Allow_List**: the fixed set of Refs the Supervisor may deploy: `main`, `scenario/error-spike`, `scenario/fog`, `scenario/dark-room`. The pattern `exorcist/*` is Reserved.
- **Reserved_Ref**: a Ref matching `exorcist/*`. It is recognised but refused for now.
- **Worktree**: a git worktree at `worktrees/<service>@<sha>` created from a Ref.
- **Deploy**: starting a Service from a Worktree. Each Deploy is recorded in the Deploy_Log.
- **Deploy_Log**: the append-only file `data/deploys.jsonl`.
- **Deploy_Record**: one line of the Deploy_Log: `id`, `service`, `ref`, `sha`, `time`, `actor`.
- **Scenario**: one of `error-spike` (payments), `fog` (orders), `dark-room` (ledger).
- **Scenario_Branch**: `scenario/<name>`, exactly one commit on top of `main`.
- **Culprit_Commit**: the single commit on a Scenario_Branch that causes the fault.
- **Plant_Script**: `scripts/plant-scenarios.mjs`.
- **Error_Ring**: bounded in-memory list of the last 200 errors of a Service.
- **Log_Ring**: bounded in-memory list of the last 500 log lines of a Service.
- **Gate_G1**: the check in `scripts/g1-check.mjs`.
- **Prometheus**: the metrics server run by `deploy/compose.yaml`.
- **Bearer_Token**: a secret read from env and sent in the `Authorization: Bearer` header.

## Requirements

### Requirement 1: Workspace and tooling

**User Story:** As a developer, I want a pnpm TypeScript workspace with working root scripts, so that every task can be checked with the same four commands.

#### Acceptance Criteria

1. THE Lab SHALL be a pnpm workspace containing the globs `services/*`, `supervisor` and `packages/*`, using Node 26 and TypeScript in strict mode.
2. WHEN `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm build` run on a workspace with no packages, THE Lab SHALL exit with code 0 for each.
3. WHEN the same four commands run on the finished workspace, THE Lab SHALL exit with code 0 for each, with no database, network or Docker required by unit and property tests.
4. THE Lab SHALL pin every dependency to an exact version checked against the registry.
5. THE `.gitignore` SHALL ignore `node_modules`, `dist`, `.env*` except `.env.example`, `data/`, `worktrees/`, `spike/`, `*.log` and `.vscode/`, and SHALL NOT ignore `.kiro/`.
6. THE Lab SHALL run TypeScript sources with Node 26 type stripping, so that source files use only erasable syntax and a Worktree needs no build step.

### Requirement 2: Service call chain

**User Story:** As a judge watching the demo, I want one realistic call chain, so that a fault in one service is visible in the others.

#### Acceptance Criteria

1. THE Lab SHALL provide the Services `gate`, `orders`, `payments` and `ledger`, where `gate` calls `orders`, `orders` calls `payments` and `payments` calls `ledger`.
2. THE Services SHALL use `node:http` and SHALL NOT use a web framework.
3. WHEN `gate` receives `POST /checkout` with a valid JSON body, THE Call_Chain SHALL create an order, charge a payment, append a ledger entry and return 200 with the order id, the payment id and the ledger entry id.
4. WHEN a downstream call fails or times out after 3 s, THE calling Service SHALL return 502 with a JSON error body and SHALL record the failure in its Error_Ring.
5. WHEN a Service receives a request body larger than 8 KiB, THE Service SHALL answer 413 without reading the rest of the body.
6. WHEN a Service receives malformed JSON or a body that fails validation, THE Service SHALL answer 400 with a JSON error body and SHALL NOT record it in the Error_Ring.
7. WHEN a Service starts without a required env name, THE Service SHALL print the missing NAME to stderr, SHALL NOT print any env value, and SHALL exit with code 1 before listening.
8. WHEN a Service receives `GET /healthz`, THE Service SHALL answer 200 with `{"ok":true}`.
9. THE Services SHALL use synthetic data only, and a Service SHALL bind the address given by `SERVICE_BIND_HOST`, which defaults to `127.0.0.1`.

### Requirement 3: Service metrics

**User Story:** As the Exorcist agent, I want standard Prometheus metrics from every service, so that I can measure errors and latency.

#### Acceptance Criteria

1. WHEN a Service receives `GET /metrics`, THE Service SHALL answer in the Prometheus text format from `prom-client`.
2. THE Service SHALL expose the counter `http_requests_total` with labels `route` and `code`.
3. THE Service SHALL expose the histogram `http_request_duration_seconds` with buckets that include 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5 and 5 seconds.
4. THE `route` label SHALL be the route template (for example `/checkout`) or `unmatched`, and SHALL NOT contain a raw request path.
5. THE Service SHALL NOT export an `up` metric; `up` comes from the Prometheus scrape.
6. THE Service SHALL NOT count `/metrics`, `/healthz` and `/debug/*` requests in `http_requests_total`.
7. WHEN a Service starts, THE Service SHALL expose `http_requests_total` at 0 with codes `200` and `500` for each of its own routes, so that the error ratio of a healthy Service is 0 rather than empty.

### Requirement 4: Error and log rings

**User Story:** As the Exorcist agent, I want recent errors and logs from each service, so that I can find the first stack frame of a fault.

#### Acceptance Criteria

1. THE Error_Ring SHALL hold at most 200 entries, each with `time`, `message`, `frame` (first stack frame) and `requestId`.
2. THE Log_Ring SHALL hold at most 500 lines.
3. WHEN a ring is full and a new entry arrives, THE ring SHALL drop the oldest entry.
4. WHEN a Service receives `GET /debug/errors` or `GET /debug/logs` with an optional `limit`, THE Service SHALL answer 200 with the newest entries, oldest first, and SHALL answer 405 for any other method.
5. WHEN a request arrives with an `x-request-id` header matching `^[A-Za-z0-9_-]{1,64}$`, THE Service SHALL reuse it; otherwise THE Service SHALL generate one, and SHALL pass it on every downstream call.
6. THE Service SHALL write each log line to stdout as well as to the Log_Ring, so that the Supervisor can capture it.
7. THE rings SHALL NOT contain env values, and the Services SHALL NOT log request bodies.

### Requirement 5: Traffic generator

**User Story:** As a judge watching the demo, I want constant background traffic, so that metrics always move.

#### Acceptance Criteria

1. WHILE the Supervisor runs, THE Traffic_Generator SHALL send `POST /checkout` requests to `gate` at `TRAFFIC_RPS` requests per second, which defaults to 5.
2. THE Traffic_Generator SHALL jitter each inter-arrival time by a random factor within plus or minus 40 percent of the base interval.
3. THE Traffic_Generator SHALL keep at most 50 requests in flight and SHALL skip a tick instead of queueing when the limit is reached.
4. IF `gate` is down or answers with an error, THEN THE Traffic_Generator SHALL keep running and SHALL NOT throw.
5. THE Traffic_Generator SHALL send only synthetic payloads and SHALL target only `gate`.

### Requirement 6: Supervisor runtime and deploy log

**User Story:** As an operator, I want every service to run from a known commit and every deploy recorded, so that the Exorcist can tie a fault to a deploy.

#### Acceptance Criteria

1. WHEN the Supervisor deploys a Service from an allow-listed Ref, THE Supervisor SHALL resolve the Ref to a commit SHA, SHALL create the Worktree `worktrees/<service>@<sha>` if it does not exist, and SHALL start the Service from it.
2. THE Supervisor SHALL run git only through `execFile` with argument arrays and SHALL NOT build a shell command string.
3. THE Supervisor SHALL start each child with an env built from a fixed list of names, and SHALL NOT pass `CHAOS_TOKEN` or `LAB_READ_TOKEN` to a child.
4. WHEN a child exits unexpectedly, THE Supervisor SHALL restart it after a delay that starts at 500 ms, doubles on each consecutive failure, and is capped at 30 s.
5. WHEN a child has run for 60 s without exiting, THE Supervisor SHALL reset the delay to 500 ms.
6. WHEN a Deploy happens, THE Supervisor SHALL append one Deploy_Record with `id` of the form `d-<n>`, `service`, `ref`, `sha`, `time` and `actor`.
7. THE Supervisor SHALL assign Deploy ids as increasing integers starting at 101, and after a restart SHALL continue from the highest id found in the Deploy_Log.
8. THE Supervisor SHALL only append to the Deploy_Log and SHALL NOT rewrite or truncate it.
9. WHEN the Supervisor boots, THE Supervisor SHALL deploy `main` for every Service with actor `supervisor`.
10. WHEN the Supervisor receives SIGTERM or SIGINT, THE Supervisor SHALL stop all children and exit with code 0.
11. THE Supervisor SHALL bind `127.0.0.1` and SHALL capture the stdout and stderr of each child into a per-service buffer of the last 500 lines that survives restarts.
12. THE Supervisor SHALL start each child in its own process group, SHALL signal the whole group when stopping it, and SHALL record the live child pid of each Service in `data/pids.json`.
13. WHEN the Supervisor starts, THE Supervisor SHALL stop every pid recorded in `data/pids.json` whose command line is still that lab Service, before deploying, and SHALL leave any other process alone.
14. WHEN the Supervisor starts, and after each Deploy, THE Supervisor SHALL remove every Worktree except the active one per Service, using `git worktree remove --force` and `git worktree prune`.
15. THE Supervisor SHALL run every git command without user or system git config (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`) and with a timeout.

### Requirement 7: Chaos controller

**User Story:** As a judge or operator, I want to apply a fault on demand and reset to healthy, so that the demo is repeatable.

#### Acceptance Criteria

1. THE Chaos_Controller SHALL accept a request only when it carries the Bearer_Token equal to `CHAOS_TOKEN`, compared in constant time, and SHALL otherwise answer 401.
2. IF `CHAOS_TOKEN` or `LAB_READ_TOKEN` is unset, shorter than 16 characters or starts with the placeholder prefix `change-me`, or IF the two tokens are equal, THEN THE Supervisor SHALL print the NAME(s), SHALL NOT print any value, and SHALL exit with code 1 before deploying anything.
3. WHEN `POST /chaos/scenarios/{name}/apply` is called with a known Scenario name, THE Chaos_Controller SHALL deploy the Scenario_Branch for the target Service and SHALL leave every other Service on `main`.
4. IF the Scenario name is unknown, THEN THE Chaos_Controller SHALL answer 404 with the code `unknown_scenario`.
5. WHEN `POST /chaos/reset` is called, THE Chaos_Controller SHALL deploy `main` for every Service and SHALL clear the active Scenario.
6. WHEN `GET /chaos/state` is called, THE Chaos_Controller SHALL answer with the active Scenario and, for each Service, its Ref, SHA, status, restart count and start time.
7. THE Chaos_Controller SHALL deploy only Refs in the Allow_List.
8. IF a deploy targets a Reserved_Ref, THEN THE Chaos_Controller SHALL answer 403 with the code `ref_reserved` and a message that fix-branch deploys are not enabled yet.
9. THE Chaos_Controller SHALL ignore the request body for the choice of Ref and path, and SHALL answer 413 for a body larger than 8 KiB.
10. WHILE a Deploy is in progress, THE Chaos_Controller SHALL serialize further apply and reset calls so that two calls never change the same Service at once.
11. THE Chaos_Controller SHALL answer other methods on a known route with 405 and unknown routes with 404.

### Requirement 8: Observability API

**User Story:** As the Exorcist agent, I want read-only access to errors, logs, deploys and commit diffs, so that I can diagnose a fault without shell access.

#### Acceptance Criteria

1. THE Observability_API SHALL accept a request only when it carries the Bearer_Token equal to `LAB_READ_TOKEN`, compared in constant time, and SHALL otherwise answer 401.
2. THE `CHAOS_TOKEN` SHALL NOT grant access to `/lab` routes and THE `LAB_READ_TOKEN` SHALL NOT grant access to `/chaos` routes.
3. WHEN `GET /lab/errors` is called with optional `service`, `since` and `limit`, THE Observability_API SHALL answer with the newest matching errors from the running Services and the exit events recorded by the Supervisor.
4. WHEN `GET /lab/logs` is called with optional `service`, `since` and `limit`, THE Observability_API SHALL answer with the newest matching lines from the Supervisor buffer.
5. WHEN `GET /lab/deploys` is called with optional `since`, THE Observability_API SHALL answer with the matching Deploy_Records, oldest first.
6. WHEN `GET /lab/commits/{sha}/diff` is called with a SHA reachable from an Allow_List Ref, THE Observability_API SHALL answer with the commit subject, author, date and diff.
7. IF the SHA is not a 7 to 40 character hex string or is not reachable from an Allow_List Ref, THEN THE Observability_API SHALL answer 404 with the code `unknown_commit`.
8. THE Observability_API SHALL cap a diff at 64 KiB, SHALL set `truncated` to true when it cuts, and SHALL cap any list response at 256 KiB.
9. THE `limit` parameter SHALL default to 100, SHALL be at most 500, and an invalid `limit`, `since` or `service` SHALL answer 400 with the code `bad_request`.
10. THE Observability_API SHALL NOT include env values in any response and SHALL answer 405 for every method other than GET.
11. THE responses SHALL be JSON with `content-type: application/json` and the text fields SHALL be treated as untrusted data by consumers.
12. EVERY `/lab/*` response, errors included, SHALL carry a top-level `"untrusted": true`, and the fields `message`, `line`, `frame`, `diff`, `subject`, `author` and `ref` SHALL have ANSI escapes and control characters removed (a diff keeps line feeds and tabs) and SHALL be capped per field.
13. THE Observability_API SHALL strip every local absolute path from frames, messages and log lines: repo files become repo-relative, dependency files become `node_modules/...`, any other path keeps only its file name.
14. THE diff route SHALL limit a commit diff to the paths `services` and `packages`.
15. THE Observability_API SHALL serve `/lab/deploys` from a bounded in-memory tail of the Deploy_Log loaded once at start and appended on each Deploy, and SHALL NOT re-read the file per request.

### Requirement 9: Scenarios and planted commits

**User Story:** As the Exorcist agent, I want each fault to have one known culprit commit, so that a diagnosis can be checked against the truth.

#### Acceptance Criteria

1. WHEN the Plant_Script runs, THE Plant_Script SHALL create the branches `scenario/error-spike`, `scenario/fog` and `scenario/dark-room`, each exactly one commit on top of `main`.
2. THE Plant_Script SHALL create each Culprit_Commit with a fixed author, committer and message, and with author and committer dates equal to the base commit's committer date plus 1 h (`error-spike`), 2 h (`fog`) and 3 h (`dark-room`), so that the SHAs are identical on every machine for a given base and every planted commit is newer than its parent.
3. WHEN the Plant_Script runs again, THE Plant_Script SHALL leave the three branches and their SHAs unchanged.
4. THE Culprit_Commit of `error-spike` SHALL be titled "simplify refund lookup", SHALL change only `payments`, and SHALL remove a null guard, so that about 30 percent of charge requests throw.
5. THE Culprit_Commit of `fog` SHALL be titled "add inventory freshness check", SHALL change only `orders`, and SHALL add a slow sequential dependency call, so that p95 rises from about 40 ms to over 1.5 s with no increase in errors.
6. THE Culprit_Commit of `dark-room` SHALL be titled "tidy config loading", SHALL change only `ledger`, and SHALL read a renamed env var, so that the process exits at start, the Supervisor crash-loops it and `up` is 0.
7. A test SHALL assert the three SHAs and SHALL fail when any of them changes.
8. WHILE `main` runs under the Traffic_Generator, THE Lab SHALL show an error ratio below 0.01 and a p95 below 0.25 s on every Service.
9. WHEN `scripts/scenario-shas.json` exists, a test SHALL assert that each scenario branch is exactly one commit whose parent is the recorded base, that the recorded base is an ancestor of `main`, and that the branch SHAs equal the record (it SHALL NOT require `main` to equal the base, because committing the record moves `main`).

### Requirement 10: Prometheus and compose

**User Story:** As an operator, I want Prometheus scraping the four services, so that the Exorcist can query metrics.

#### Acceptance Criteria

1. THE `deploy/prometheus.yml` SHALL scrape the four Services every 5 s and SHALL attach a `service` label to each target.
2. THE `deploy/compose.yaml` SHALL run Prometheus and SHALL work with `docker compose` on the development Mac and with `podman compose` on EC2.
3. THE compose file SHALL publish Prometheus only on `127.0.0.1`.
4. THE compose file SHALL read scrape target addresses from files in `deploy/`, with no secret in them.
5. ON Linux, `deploy/compose.linux.yaml` SHALL run Prometheus on the host network, listening on `127.0.0.1` only, so that the Services stay bound to `127.0.0.1` and never need `0.0.0.0`.

### Requirement 11: Gate G1 check

**User Story:** As the orchestrator, I want one script that proves the lab works end to end, so that Gate G1 is a pass or fail.

#### Acceptance Criteria

1. WHEN `scripts/g1-check.mjs` runs, THE Gate_G1 SHALL start the Supervisor and Prometheus and wait until all four targets are up.
2. FOR EACH Scenario, THE Gate_G1 SHALL apply it and SHALL assert within 30 s that the matching PromQL signal moves: error ratio above 0.2 for `error-spike`, p95 above 1 s for `fog`, and `up == 0` for `dark-room`.
3. AFTER each Scenario, THE Gate_G1 SHALL call reset and SHALL assert that the signal returns to healthy within 30 s.
4. THE Gate_G1 SHALL print a short table with one row per Scenario: signal, observed value, seconds to detect, seconds to recover.
5. THE Gate_G1 SHALL exit with code 0 when every assertion holds and with code 1 otherwise, and SHALL stop what it started.

### Requirement 12: Documentation and configuration

**User Story:** As a new contributor, I want setup notes and an env template, so that I can run the lab in minutes.

#### Acceptance Criteria

1. THE `docs/DEV.md` SHALL describe setup, env names only, how to run the Supervisor and Prometheus, and how to run Gate_G1.
2. THE `.env.example` SHALL list env names with placeholder values only.
3. THE `docs/KIRO_USAGE.md` SHALL get one line for each finished task.
4. THE Lab SHALL contain no secret, no absolute home path and no production data in any committed file.
