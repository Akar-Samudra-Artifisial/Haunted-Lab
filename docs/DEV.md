# Developing Haunted Lab

The lab is synthetic and broken on purpose. Nothing here touches real payments or real data.

## Setup

- Node 26 (`.nvmrc`), pnpm 11 (`packageManager` in `package.json`). Nothing else is installed globally.
- A container runtime for Prometheus: colima + `docker compose` (or the standalone `docker-compose`) on a Mac, `podman compose` (or docker) on Linux / EC2.

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

Unit, property and integration tests need no Docker and no public network. The integration test starts the real supervisor and services on random loopback ports against a temporary lab repo.

Services and the supervisor are TypeScript run directly by Node (type stripping, erasable syntax only), so there is no build output; `pnpm build` is a type check.

## Environment (names only)

Copy `.env.example` to `.env` and fill in values. Never commit `.env`.

| Name | Used by | Default |
| --- | --- | --- |
| `CHAOS_TOKEN` | supervisor `/chaos/*` bearer token | required |
| `LAB_READ_TOKEN` | supervisor `/lab/*` bearer token | required |
| `SUPERVISOR_PORT` | supervisor, binds `127.0.0.1` | `4100` |
| `GATE_PORT`, `ORDERS_PORT`, `PAYMENTS_PORT`, `LEDGER_PORT` | services | `4001`..`4004` |
| `SERVICE_BIND_HOST` | services | `127.0.0.1` |
| `TRAFFIC_RPS` | traffic generator (0 disables, max 50) | `5` |
| `LAB_REPO_DIR` | repo the deploy refs come from | this checkout |
| `LAB_DATA_DIR`, `LAB_WORKTREES_DIR` | deploy log, worktrees | `data/`, `worktrees/` |
| `LAB_ECHO_CHILD_OUTPUT` | `0` to stop echoing service output | `1` |
| `LAB_ORIGIN_URL` | public https origin the `incident/*` fix refs are fetched from | the GitHub repo |
| `FIX_RUN_AS_USER` | optional OS user for fix children (EC2) | unset |
| `LAB_ALLOW_FILE_ORIGIN` | `1` allows a `file://` origin (tests only) | `0` |
| `PROMETHEUS_PORT`, `LAB_HOST_ADDR` | `deploy/compose.yaml` | `9090`, `host-gateway` |

Tokens: at least 16 characters each, different from each other, and not the `change-me...` placeholders from `.env.example` (for example `openssl rand -hex 24`). Otherwise the supervisor exits at start with the variable names only.

The supervisor passes each service only its own names (port, bind host, downstream URL). Tokens never reach a service and are never logged.

## Scenario branches

```sh
node scripts/plant-scenarios.mjs              # plant on this checkout's main, write scripts/scenario-shas.json
node scripts/plant-scenarios.mjs --repo <dir> # plant in another repo
node scripts/build-lab-repo.mjs <empty-dir>   # deterministic snapshot repo of the runtime files + planted branches
```

Planting needs the services on `main`. Each scenario branch is one commit on `main` with a fixed identity (`Haunted Lab Bot`) and dates of base committer date + 1 h / 2 h / 3 h, so a given `main` always yields the same SHAs and the planted commits are newer than their parent. The script never moves `main`, never touches the working tree and never pushes. Re-running is a no-op.

`supervisor/test/plant.test.ts` asserts the exact SHAs for the runtime snapshot (only `services/*/src`, `services/*/package.json`, `packages/lab-common/src` and its `package.json` go into it). If you change a runtime file on purpose, update `EXPECTED` in that test. Once `scripts/scenario-shas.json` exists, a second test checks this checkout's branches against it: each branch must be one commit on the recorded base, the base must be an ancestor of `main` (so committing the record itself is fine), and the SHAs must match. Re-plant and update the record if `main` was rewritten or the scenario code changed.

## Run the lab

```sh
set -a; . ./.env; set +a
node supervisor/src/main.ts                       # boots main for all four services, starts traffic

# Mac (colima)
docker compose -f deploy/compose.yaml up -d       # or docker-compose -f deploy/compose.yaml up -d
# Linux / EC2
podman compose -f deploy/compose.yaml -f deploy/compose.linux.yaml up -d
```

Prometheus is at `http://127.0.0.1:9090` in both cases. It reaches the services as `lab-host:<port>` (see `deploy/targets/lab.json`; edit it if you change the service ports).

- Mac: Prometheus runs on the colima bridge network, is published on `127.0.0.1:9090` only, and `lab-host` maps to `host-gateway`, which colima forwards to the Mac's loopback. Services stay on `127.0.0.1`.
- Linux: there `host-gateway` is a bridge address that only reaches services listening on `0.0.0.0`. `compose.linux.yaml` instead puts Prometheus on the host network (`network_mode: host`, no published ports), listening on `127.0.0.1:9090`, with `lab-host` = `127.0.0.1`. Services stay on `127.0.0.1`; never bind them to `0.0.0.0` (their `/debug/*` and `/metrics` must not leave the host).

The supervisor records each child's pid in `data/pids.json` and runs each child in its own process group. If the supervisor is killed hard (SIGKILL), the next start stops the leftover children (only processes whose command line is still that lab service) before binding ports, and removes stale worktrees, so only the active worktree per service stays under `worktrees/`.

The supervisor deploys from this checkout by default (the scenario and, later, fix branches are refs of this repo). It never touches the working tree, index or branches; it only adds and removes detached worktrees under `worktrees/`.

```sh
curl -s -H "Authorization: Bearer $CHAOS_TOKEN" -X POST http://127.0.0.1:4100/chaos/scenarios/fog/apply
curl -s -H "Authorization: Bearer $CHAOS_TOKEN" http://127.0.0.1:4100/chaos/state
curl -s -H "Authorization: Bearer $LAB_READ_TOKEN" "http://127.0.0.1:4100/lab/errors?service=payments&limit=5"
curl -s -H "Authorization: Bearer $CHAOS_TOKEN" -X POST http://127.0.0.1:4100/chaos/reset
```

Stop with Ctrl-C (the supervisor stops every service) and `docker compose -f deploy/compose.yaml down` (add `-f deploy/compose.linux.yaml` on Linux).

## Gate G1

```sh
node scripts/g1-check.mjs
```

Needs ports 4001-4004, 4100 and 9090 free on `127.0.0.1`. On Linux it adds `deploy/compose.linux.yaml`. It generates throwaway tokens, starts the supervisor (5 rps) and Prometheus (compose project `haunted-lab-g1`), waits for four targets and a healthy baseline, then for each scenario applies it, asserts the PromQL signal within 30 s (`error-spike`: payments 5xx ratio > 0.2; `fog`: orders p95 > 1 s; `dark-room`: `up{service="ledger"} == 0`), resets and asserts recovery within 30 s. It prints a table, stops everything it started and exits 0 or 1.

If `scripts/scenario-shas.json` verifies against this checkout (each scenario branch one commit on the recorded base, the base an ancestor of `main`, the SHAs equal) and `main` holds the services, G1 uses the real scenario branches and prints `lab repo: this checkout (...)`. Otherwise it builds the snapshot lab repo in a temp dir and prints why.

## Fix deploys (`POST /chaos/deploy-fix`)

Haunted Ops opens fix pull requests `exorcist/<huntId>` -> `incident/<huntId>` against this repo; after a human merges one, it calls:

```sh
curl -s -H "Authorization: Bearer $CHAOS_TOKEN" -H 'content-type: application/json' \
  -d '{"service":"payments","ref":"incident/<cuid>","sha":"<40 hex>"}' http://127.0.0.1:4100/chaos/deploy-fix
```

Statuses (the Haunted Ops contract): 200 `{ deployId, service, sha }`; 400 bad body (also over 8 KiB); 401 bad token; 404 `unknown_ref`; 409 `not_head`, `chain_too_long`, `no_allowed_base`, `empty_fix`; 422 `outside_service`, `manifest_change` (also any `node_modules` path), `binary_or_special_change` (also a new executable file), `diff_too_large` (over 400 lines, a blob over 64 KiB, over 256 KiB in total, or over 200 files); 503 `origin_unreachable`, `lab_not_pinned`, `deploy_failed`, `isolation_unavailable`, `busy` (four requests already waiting).

- **Mirror.** The supervisor deploys and diffs from the bare mirror `data/repo.git` (git-ignored, `data/` is `0700`). At every start it copies `main` and `scenario/*` from this checkout into it; from `LAB_ORIGIN_URL` it fetches only the one requested `incident/*` ref (`https` only, no credentials, `--end-of-options`, 30 s timeout). It keeps the 50 newest incident refs locally. Nothing is fetched into this checkout, and its `git worktree list` stays clean: worktrees under `worktrees/` belong to the mirror.
- **Rule.** `sha` must be the head of the fetched ref; its first-parent chain (at most 20 commits) must reach `main` or a scenario head pinned by `scripts/scenario-shas.json`; every commit (a merge counts against its first parent) may touch only `services/<service>/`, no binary, symlink, submodule, mode or manifest change, and at most 400 changed lines in total.
- **Worktrees.** Named worktrees: only the active one per service. A fix worktree stays for an hour after it stops being active (reuse, inspection), then the cleanup at start and after every deploy removes it.
- **Isolation.** Fix children get a whitelist env only (own port, bind host, downstream URL, `NODE_ENV=production`, `PATH=/usr/bin:/bin`) and run under `node --permission` with fs read limited to their worktree, the checkout's `node_modules`, `services/<service>/node_modules` and `packages/lab-common`, plus `--allow-net`; no fs write, child process, worker, addon, WASI, FFI or inspector.

| | Mac (development) | EC2 (demo; set up by Haunted Ops `deploy-demo`) |
| --- | --- | --- |
| Env | whitelist only | whitelist only |
| Node permission model | yes | yes |
| OS user | the supervisor's own user (logged once at start) | `FIX_RUN_AS_USER`, a separate user without sudo |
| Supervisor tokens readable by fix code | not through Node (no fs read outside the allow-list, no child process); the OS would allow the same user | no: `/proc/<pid>/environ` needs ptrace read access, which the kernel refuses across uids; plus `hidepid=2` / systemd `ProtectProc=invisible` |
| Instance credentials | none on a Mac | no instance role for that user; IMDS blocked for its uid by a firewall owner match |
| `data/` (mirror, deploy log, pids) | readable by the same user outside Node | `0700`, not readable |

Node itself calls its permission model a seat belt, not a security boundary against malicious code; on EC2 the separate OS user is the boundary. `FIX_RUN_AS_USER` needs the supervisor to hold `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL` (systemd `AmbientCapabilities`): the first two to start fix children as that user, `CAP_KILL` to stop them. A startup probe starts an idle child as the user, SIGTERMs it and refuses to run (naming the missing capability) if either step fails. With `NODE_ENV=production` and no `FIX_RUN_AS_USER`, the supervisor still runs scenarios but every `deploy-fix` answers 503 `isolation_unavailable`.

`--allow-net` does not limit destinations, so the permission model is not a network boundary: on EC2 an owner-match firewall rule (Haunted Ops `deploy-demo`) allows only loopback for the fix user and blocks IMDS; on a Mac fix code can reach any host and can signal the supervisor (same user).

### Fix-deploy check

```sh
REF=incident/<cuid> SHA=<40 hex> node scripts/fix-deploy-check.mjs
```

Used by the Haunted Ops G-MVP gate. It fetches only `REF` from the origin into a temp bare repo, finds the pinned scenario the fix sits on, starts a supervisor on this checkout with a temp data dir and throwaway tokens (never printed), applies the scenario and checks it is broken, calls `deploy-fix`, checks the signal is healthy again (payments 5xx ratio, orders p95 from the histogram, ledger `/healthz`), checks the Deploy Record (`actor: "exorcist"`), resets, prints a table and exits 0 or 1. It needs ports 4001-4004 and 4100 free, never pushes, and stops everything it started. `LAB_ORIGIN_URL` overrides the origin (with `LAB_ALLOW_FILE_ORIGIN=1` for a local `file://` test origin); it is checked with the supervisor's own validator before anything is fetched.

```sh
CANARY=1 node scripts/fix-deploy-check.mjs
```

Isolation canary, local only (never GitHub): a fix on `main` from a temp origin adds payments code that at boot tries `process.binding`, reading `/proc/<ppid>/environ` (Linux), `child_process`, `new Worker`, reading this checkout's `.env`, and `process.kill(process.ppid, 0)`. The check passes only if each is denied; signalling the parent is allowed in development (same OS user) and printed as a WARN.

## Mac and EC2 notes

- colima: a container reaches the Mac's `127.0.0.1` through `host-gateway`, so the services stay on loopback. Verified with `docker-compose` 5.6 on colima.
- The `docker compose` plugin is not installed on the dev Mac; G1 falls back to `docker-compose`, then `podman compose`.
- Linux / EC2: use `compose.linux.yaml` (host network). The merged config was checked with `docker-compose config`; it has not been run on EC2 yet.
- `/lab/*` responses carry `"untrusted": true`; their text is cleaned (no control characters, ANSI escapes or local absolute paths) and must be treated as data by any agent reading it.
- `http_requests_total` starts at 0 for codes 200 and 500 on every route. Queries should still use `or vector(0)` for ratios and `avg_over_time(up[30s])` for `up`, since a redeploy restarts a process.
- Node's built-in `fetch` adds about 300 ms on this Mac when it reuses an idle keep-alive socket. Service-to-service calls and the traffic generator use `node:http` (`httpRequest` in `@haunted-lab/common`) so this does not blur the latency signal.
