# Design Document: fix-deploy

## Overview

Haunted Ops opens a fix pull request `exorcist/<huntId>` -> `incident/<huntId>` against this repo, where `incident/<huntId>` was created at the deployed scenario head D. After a human merges it on GitHub, Haunted Ops calls `POST /chaos/deploy-fix` with `{ service, ref, sha }`. The lab fetches that one ref into a dedicated bare mirror, checks that `sha` is the ref head and that its first-parent chain is a small, service-local change on top of a pinned head, then deploys it through the normal deploy path as an isolated child, and records a Deploy Record with `actor: "exorcist"`.

Key decisions:

- **One mirror for everything the supervisor runs.** `data/repo.git` (bare) replaces the developer checkout as the deploy and diff repo. It is seeded from the checkout (`main`, `scenario/*`) at every start and fetches only `incident/*` from the origin. The checkout is never fetched into, and its worktree list stays clean. Rejected: fetching into the checkout (pollutes the developer's refs, and a fetched ref could shadow a local branch); a separate mirror only for fixes (two repos for deploys and diffs to keep in sync).
- **A pure rule, then I/O.** git output (ref head, first-parent chain, per-commit raw and numstat) is read into plain data, and `deployFixAllowed` decides. The rule is the one Haunted Ops models in its fake lab (its Property 11), extended with the content limits asked for here.
- **Fix code is untrusted.** Merged fixes are human-reviewed but AI-written. They run under Node's permission model with a whitelist env and, on EC2, as a separate OS user. The design says plainly what each platform gets.
- **No new dependency.** Everything uses `node:child_process`, git and Node's built-in permission model.

## Architecture

```mermaid
flowchart LR
  API[Haunted Ops api] -->|POST /chaos/deploy-fix Bearer CHAOS_TOKEN| SUP[Supervisor 127.0.0.1:4100]
  SUP -->|1 validate body| V[validateDeployFixBody]
  SUP -->|2 ls-remote + fetch one ref| MIR[(data/repo.git bare mirror)]
  ORIGIN[(Origin: GitHub https)] -->|incident/<cuid> only| MIR
  SRC[(Source checkout)] -->|seed main, scenario/* at start| MIR
  SUP -->|3 read chain: rev-list, diff-tree| MIR
  SUP -->|4 deployFixAllowed| RULE[pure rule]
  SUP -->|5 Lab mutex: re-check head, deploy| LAB[Lab controller]
  LAB -->|git worktree add| WT[(worktrees/service@sha)]
  LAB -->|spawn node --permission, whitelist env, uid FIX_RUN_AS_USER| CHILD[Fix child]
  LAB -->|append actor exorcist| DL[(data/deploys.jsonl)]
```

Request flow and status at each step:

1. Auth (401), body (400).
2. Fetch lock. `git ls-remote --exit-code origin refs/heads/<ref>`: exit 2 -> 404 `unknown_ref`; network error or timeout -> 503 `origin_unreachable`. Then `git fetch --no-tags --no-recurse-submodules origin --end-of-options +refs/heads/<ref>:refs/heads/<ref>`.
3. Allowed heads (503 `lab_not_pinned` if the record does not verify). Read the head of the local ref and the first-parent chain of `sha` (at most 21 commits so "too long" is detectable) with per-commit file changes, and the total numstat from the reached head to `sha`.
4. `deployFixAllowed` -> 409 / 422 or accept.
5. `Lab.deployFix` under the mutex: re-check the ref head (409 `not_head` if it moved), idempotence check, deploy (503 `deploy_failed` on failure), Deploy Record, 200.

## Components and Interfaces

### Route: `POST /chaos/deploy-fix` (the Contract)

Source: `../haunted-ops/.kiro/specs/fix-proposal-flow/design.md`, section "Lab contract: `POST /chaos/deploy-fix` (external interface)". Copied:

```
POST {CHAOS_URL}/chaos/deploy-fix
Authorization: Bearer <CHAOS_TOKEN>
Content-Type: application/json
{ "service": "payments", "ref": "incident/<cuid>", "sha": "<40 hex>" }

200 { "deployId": "d-210", "service": "payments", "sha": "<40 hex>" }
400 bad body (unknown service, ref not incident/<cuid>, sha not 40 hex)
401 bad token
404 the ref does not exist on origin
409 sha is not the head of the ref, or the chain is refused
422 the chain touches files outside services/<service>/
503 origin unreachable
```

Lab-side codes inside those statuses (body `{ "error": { "code", "message" } }`):

| Status | Code | When |
| --- | --- | --- |
| 200 | (none) | deployed, or already running this ref at this sha (existing `deployId`) |
| 400 | `bad_request` | body over 8 KiB, not an object, extra or missing keys, unknown service, ref not `^incident/c[a-z0-9]{24}$`, sha not `^[0-9a-f]{40}$` |
| 401 | `unauthorized` | missing or wrong token (the read token never works here) |
| 404 | `unknown_ref` | the origin has no such ref |
| 409 | `not_head` | `sha` is not the head of the fetched ref (also when it moved before the mutex) |
| 409 | `chain_too_long` | no allowed head within 20 first-parent commits |
| 409 | `no_allowed_base` | a root commit was reached before an allowed head |
| 409 | `empty_fix` | `sha` is itself an allowed head |
| 422 | `outside_service` | a chain commit touches a path outside `services/<service>/` |
| 422 | `manifest_change` | a chain commit touches a Manifest File |
| 422 | `binary_or_special_change` | binary, symlink, submodule or mode change |
| 422 | `diff_too_large` | more than 400 changed lines from the allowed head to `sha` |
| 503 | `origin_unreachable` | network error, DNS error or git timeout while talking to the origin |
| 503 | `lab_not_pinned` | `scripts/scenario-shas.json` exists but does not verify against the mirror |
| 503 | `deploy_failed` | accepted, but the worktree or spawn failed; the previous child keeps running |

The Contract's 503 reads "origin unreachable"; the lab also uses 503 for the two "lab cannot do it now" cases so that the status set stays exactly the Contract's. Haunted Ops treats every 503 as retryable-then-fail, which fits both. Oversize bodies, normally 413 on this server, become 400 on this route only. 405 for other methods is the server's usual answer and is outside the Contract.

Body validator: `validateDeployFixBody(value): { ok: true, request } | { ok: false }`. Exactly three keys, string values, the three patterns. The ref is only ever used after this check, and every git call that takes it also puts `--end-of-options` before it.

### The rule: `deployFixAllowed`

```ts
deployFixAllowed(input: {
  head: string;                 // head of the fetched incident ref
  sha: string;                  // requested Fix_Sha
  chain: ChainCommit[];         // first-parent walk from sha, newest first, at most 21 entries
  reachedHead: string | null;   // the allowed head the walk stopped at, or null
  rootReached: boolean;         // the walk hit a commit with no parent
  totalLines: number;           // added + deleted from reachedHead to sha
  allowedHeads: readonly string[];
  service: ServiceName;
}): { ok: true; base: string } | { ok: false; status: 409 | 422; code: FixRefusal }
```

Order: `not_head`, `empty_fix`, `chain_too_long` (more than 20 commits without an allowed head), `no_allowed_base`, then per commit in chain order `binary_or_special_change`, `manifest_change`, `outside_service`, then `diff_too_large`. The first failing rule wins, so a result is deterministic. The function is pure: no I/O, no clock, no randomness. Haunted Ops' fake route keeps its smaller signature; this one adds the content inputs.

Chain reading (`fix-chain.ts`), all through `execFile` arrays in the mirror:

- `git rev-list --first-parent --max-count=21 <sha> --` gives the walk; it stops early when an entry is in `allowedHeads`.
- For each commit before the reached head: `git diff-tree --no-commit-id -r -M --raw -z <commit>^1 <commit>` (first parent, so a merge counts as its whole effect) and `git diff-tree --numstat -z` for binary detection (`-\t-`). Root commits are reported as `rootReached`.
- `git diff --numstat -z <reachedHead> <sha>` gives `totalLines`.
- Each output is size-capped (1 MiB); a cap hit is `diff_too_large`.

Merge fix: the merge commit's first parent is D, so the chain is `[merge]`, compared with D. Squash and rebase merges and fast-forwards give one or more ordinary commits on D.

### Mirror (`mirror.ts`)

- Path `LAB_DATA_DIR/repo.git` (default `data/repo.git`). `data/` is created with mode `0700`.
- Create if missing: `git clone --bare --no-hardlinks -- <source> <mirror>`.
- Every start: `git remote set-url origin <LAB_ORIGIN_URL>`; `git config --replace-all remote.origin.fetch +refs/heads/incident/*:refs/heads/incident/*`; `git fetch --no-tags <source> +refs/heads/main:refs/heads/main +refs/heads/scenario/*:refs/heads/scenario/*` (local file protocol allowed for this one call); delete any local ref outside `main`, `scenario/*` and `incident/*`.
- Fetch of a fix: as in the flow above, under a fetch lock, `GIT_ALLOW_PROTOCOL=https` (`https:file` only with `LAB_ALLOW_FILE_ORIGIN=1`), plus the existing isolated git env (`GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0`, no `HOME`) and the 30 s timeout. No credentials are ever configured; the origin is public.
- Incident ref limit: after each fetch, keep the 50 newest `incident/*` refs by fetch time (recorded in `data/incident-refs.json`), `git update-ref -d` the rest locally, never on the origin.
- Allowed heads: if `scripts/scenario-shas.json` exists in the source, `verifyPlantRecord(mirror, record)` must return no problem, and the allowed heads are the three recorded SHAs plus the mirror's `main`. Without the record (snapshot repos in tests and G1), they are the four branch heads as found, and the supervisor logs "allowed heads not pinned (no scenario-shas.json)" once.

`LAB_ORIGIN_URL` validation (`parseOriginUrl`): `new URL()`; protocol `https:`; no `username`, `password`, `search` or `hash`; host name not an IPv4 or IPv6 literal; path ends in `.git` or not, any. With `LAB_ALLOW_FILE_ORIGIN=1`, an absolute `file:///...` URL is also accepted. Anything else is a `ConfigError` naming `LAB_ORIGIN_URL`.

### Allow-list (`refs.ts`)

`classifyRef(ref)` returns:

- `named` for `main`, `scenario/error-spike`, `scenario/fog`, `scenario/dark-room` (boot, apply, reset);
- `fix` for `^incident/c[a-z0-9]{24}$` (only `Lab.deployFix` accepts it);
- `denied` for anything else, including `exorcist/*` (the old `reserved` class and 403 `ref_reserved` are removed).

`Lab.#deploy` refuses `fix` unless called from `deployFix`, so apply, reset and boot can never run an incident ref.

### Diff route

`reachableCommit` checks ancestry against the allowed heads and every local `incident/*` ref of the mirror. The diff keeps `-- services packages`, the 64 KiB cap, field cleaning and `untrusted: true`.

### Worktrees

- Registered to the mirror (`git -C data/repo.git worktree add --detach`). Names stay `<service>@<sha>`.
- Migration at start: worktrees under `worktrees/` registered to the source checkout (from earlier versions) are removed with `git -C <source> worktree remove --force`, then `git -C <source> worktree prune`.
- Scenario and `main` worktrees: unchanged rule (only the active one per service, previous one retired after each deploy).
- Fix worktrees: not retired immediately. When one stops being active, its directory mtime is set to now (`utimes`). The cleanup that runs at start and after every deploy removes every fix worktree (its sha is not one of the allowed heads) that is not active and whose mtime is more than 1 h old. Keeping it for an hour lets a redeploy of the same fix reuse it and leaves it on disk for inspection.

### Isolation of fix children (`isolation.ts`)

Env whitelist (`fixChildEnv(service, ports, bindHost)`): own `<SERVICE>_PORT`, `SERVICE_BIND_HOST`, the downstream URL (`ORDERS_URL` / `PAYMENTS_URL` / `LEDGER_URL`, built from ports), `NODE_ENV=production`, `PATH=/usr/bin:/bin`. Nothing is inherited from the supervisor.

argv (`fixChildArgs(worktree, source)`):

```
node --permission
     --allow-fs-read=<worktree>
     --allow-fs-read=<source>/node_modules
     --allow-fs-read=<source>/packages/lab-common
     --allow-net
     src/main.ts --lab-service=<service>
```

`<source>/packages/lab-common` is needed because the service's `node_modules/@haunted-lab/common` is a workspace symlink that resolves into the checkout. That package cannot be changed by a fix (the chain rule allows only `services/<service>/`). `--allow-net` is required: the service listens and calls its downstream, and Node's network permission is all or nothing. No write, child process, worker, addon, WASI, FFI or inspector permission is granted, so the child cannot spawn `ps`, read `/proc`, or read `data/` or the supervisor's source. A risk check (task 4.1) confirms on Node 26.7 that type stripping, the symlinked `node_modules` and `prom-client` work under these flags.

Node's documentation states the permission model is a seat belt against mistakes, not a security boundary against malicious code. It is the only layer on the Mac. On EC2 the OS user is the real boundary.

`FIX_RUN_AS_USER` (optional):

- Validated name `^[a-z_][a-z0-9_-]{0,31}$`; uid and gid from `execFile('id', ['-u', name])` and `['-g', name]`; uid 0 and the supervisor's own uid are refused.
- Fix children are spawned with `{ uid, gid }`. That needs the supervisor to hold `CAP_SETUID` and `CAP_SETGID` (systemd `AmbientCapabilities=` in `deploy-demo`); it does not need to run as root.
- Startup probe: spawn `node -e 0` as the user; failure -> `ConfigError` naming `FIX_RUN_AS_USER`, exit 1.
- Files: the fix user needs read access to `worktrees/` and the checkout's `node_modules` and `packages/lab-common` (a shared group, mode `0750`, set by `deploy-demo`), and no access to `data/` (`0700`).
- Not set: one log line at start, `fix code runs as the supervisor's user (FIX_RUN_AS_USER not set; development only)`.

What each platform gets:

| | Mac (development) | EC2 (demo, set up by Haunted Ops `deploy-demo`) |
| --- | --- | --- |
| Env | whitelist only | whitelist only |
| Node permission model | yes | yes |
| OS user | the supervisor's own user | separate `FIX_RUN_AS_USER`, no sudo |
| Supervisor env readable by fix code | not through Node (no fs read outside the allow-list, no child process); the OS would allow the same user to read it | no: different uid; `/proc/<pid>/environ` needs ptrace read access, which the kernel refuses across uids; plus `hidepid=2` / systemd `ProtectProc=invisible` |
| Instance credentials | none on the Mac | no instance role for that user; IMDS (`169.254.169.254`) blocked for its uid by an owner-match firewall rule |
| `data/` (mirror, deploy log, pids) | readable by the same user outside Node | `0700`, unreadable |

Tokens and `/proc/<ppid>/environ`: the supervisor reads its tokens from env at start; the initial environ block of a process stays in `/proc/<pid>/environ` for its life, so deleting them from `process.env` would not help. The protection is the uid boundary above. The fix child's own `/proc/self/environ` contains only the whitelist.

## Data Models

```ts
type ServiceName = 'gate' | 'orders' | 'payments' | 'ledger';

interface DeployFixRequest { service: ServiceName; ref: string /* incident/<cuid> */; sha: string /* 40 hex */ }
interface DeployFixResponse { deployId: string; service: ServiceName; sha: string }

interface FileChange {
  path: string;
  oldPath?: string;               // renames and copies
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T';
  oldMode: string;                // '000000' for added
  newMode: string;                // '000000' for deleted
  binary: boolean;                // numstat '-\t-'
  added: number;
  deleted: number;
}
interface ChainCommit { sha: string; parents: string[]; changes: FileChange[] }

type FixRefusal =
  | 'not_head' | 'chain_too_long' | 'no_allowed_base' | 'empty_fix'
  | 'outside_service' | 'manifest_change' | 'binary_or_special_change' | 'diff_too_large';

type RefClass = 'named' | 'fix' | 'denied';

interface DeployRecord { id: string; service: ServiceName; ref: string; sha: string; time: string; actor: 'supervisor' | 'chaos' | 'exorcist' }
```

Files: `data/repo.git` (bare mirror), `data/incident-refs.json` (`{ ref: fetchedAtIso }`, at most 50), `data/deploys.jsonl`, `data/pids.json`; all under `data/` (`0700`, git-ignored).

New config (names only): `LAB_ORIGIN_URL`, `LAB_ALLOW_FILE_ORIGIN` (tests), `FIX_RUN_AS_USER`. `LAB_REPO_DIR` keeps its meaning as the source checkout that seeds the mirror.

Deploy log open (leftover): read the last 256 KiB; drop the first partial line; parse; if no valid record, read the previous 256 KiB and repeat (up to the file start). The next id is the last valid record's id + 1 (ids only grow); the tail ring (1000) is filled from the parsed chunk(s). Memory is bounded by the chunk size times the number of chunks needed to find one valid record.

## Correctness Properties

### Property 1: The deploy rule accepts exactly a clean chain from the head to an allowed head
For any head, requested sha, first-parent chain, allowed heads and service, `deployFixAllowed` accepts iff `sha` equals the head, `sha` is not an allowed head, an allowed head is reached within 20 commits without hitting a root, every chain commit compared with its first parent touches only `services/<service>/` (both paths of a rename), no change is binary, a symlink, a submodule or a mode change, no Manifest File is touched, and the total diff is at most 400 lines. Otherwise it returns exactly the first failing rule in the fixed order, with status 409 for head and chain rules and 422 for content rules.
**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5**

### Property 2: Body validation is total and exact
For any JSON value or byte string, `validateDeployFixBody` returns a request iff it is an object with exactly `service`, `ref` and `sha`, `service` is one of the four, `ref` matches `^incident/c[a-z0-9]{24}$` and `sha` matches `^[0-9a-f]{40}$`; otherwise `bad_request`. It never throws, and no ref with `..`, a leading `-`, whitespace, `:` or a control character is ever accepted.
**Validates: Requirements 1.3, 1.4**

### Property 3: Refs are classified into named, fix and denied
For any string, `classifyRef` returns `named` iff it is `main` or one of the three scenario branches, `fix` iff it matches the Incident Ref pattern, and `denied` otherwise; boot, apply and reset never pass a `fix` ref to a runner.
**Validates: Requirements 7.1, 7.2, 7.3, 7.4**

### Property 4: The origin URL validator accepts only plain public https
For any string, `parseOriginUrl` accepts it iff it is an `https:` URL with a non-IP host and no user name, password, query or fragment, or, only when file origins are allowed, an absolute `file://` URL; a rejection names `LAB_ORIGIN_URL` and never the value.
**Validates: Requirements 2.4, 2.5**

### Property 5: A fix child gets exactly the whitelist env
For any ports, bind host, service and supervisor env (including tokens), `fixChildEnv` returns exactly the service's port, bind host, downstream URL, `NODE_ENV=production` and `PATH=/usr/bin:/bin`, and no value from the supervisor env appears in it.
**Validates: Requirements 9.1**

### Property 6: A fix child's permission flags are exactly the allowed set
For any worktree and source path, `fixChildArgs` contains `--permission`, exactly three `--allow-fs-read` entries (the worktree, `<source>/node_modules`, `<source>/packages/lab-common`) and `--allow-net`, and contains no other `--allow-*` flag.
**Validates: Requirements 9.2, 9.3**

### Property 7: Fix worktree cleanup removes exactly the stale ones
For any set of worktree names, active deployments, allowed heads, mtimes and clock, the cleanup plan removes a worktree iff it is a fix worktree (its sha is not an allowed head), it is not active, and its mtime is more than 1 h before now; it never names a path outside the worktrees directory, and scenario worktrees follow the existing rule.
**Validates: Requirements 6.5**

### Property 8: Diffs are served for commits reachable from allowed heads or fetched incident refs only
For any commit graph, allowed heads, local incident refs and requested string, the diff route serves a commit iff the string is 7 to 40 hex that resolves to a commit reachable from an allowed head or a local incident ref.
**Validates: Requirements 8.1**

### Property 9: The incident ref limit keeps the newest 50
For any list of fetch times, the pruning plan keeps exactly the 50 newest incident refs (ties broken by name) and deletes only incident refs.
**Validates: Requirements 6.6**

### Property 10: Opening the deploy log from its tail matches a full read
For any deploy log content (valid records, malformed lines, a partial last line) and chunk size, opening from the tail gives the same next id and the same newest records (up to the tail size) as parsing the whole file, while reading at most the chunks needed to find one valid record plus the tail.
**Validates: Requirements 11.2**

## Error Handling

- Body problems: 400 `bad_request`, no git call. Oversize: 400 on this route (not 413).
- Token: 401 with `www-authenticate: Bearer`; the read token never opens `/chaos/*`.
- Origin: `ls-remote` exit 2 -> 404 `unknown_ref`; any other git failure or the 30 s timeout while talking to the origin -> 503 `origin_unreachable`. Messages are generic; git stderr goes to the supervisor log after field cleaning, never into the response.
- Record does not verify: 503 `lab_not_pinned`; scenarios still deploy (they come from the mirror's `main` and `scenario/*`).
- Rule refusals: 409 or 422 with one code from `deployFixAllowed`.
- Head moved between the check and the mutex: 409 `not_head`.
- Deploy failure after acceptance (worktree add, spawn): 503 `deploy_failed`, previous child kept, no Deploy Record.
- Fix child crash after a successful deploy: the usual backoff restart; the 200 was already sent. Haunted Ops confirms through `GET /lab/deploys` and the metrics, as its design says.
- `FIX_RUN_AS_USER` invalid, root, own uid, or probe fails: `ConfigError` naming the variable, exit 1.
- Mirror creation or seeding fails at start: exit 1 with a generic message; no deploy happens from the source checkout as a fallback.

## Testing Strategy

- Origin Fixture (`supervisor/test/fix-origin.ts`): a bare repo in a temp folder built from the snapshot repo (`buildSnapshotRepo` + `plantScenarios`), with helpers to push `incident/<cuid>` refs made with `commit-tree` under a fixed identity and fixed dates: a good fix (restores the refund guard on `scenario/error-spike`), a merge fix (merge commit whose second parent is the fix), a squash fix, a commit touching `services/orders/`, a `services/payments/package.json` change, a binary file, a symlink, a 21-commit chain, and an over-400-line change. Fixed CUIDs such as `incident/c000000000000000000000001`.
- Unit tests: body validator edge cases including injection strings (`incident/c...;rm`, `--upload-pack=x`, `incident/../main`, `incident/C...` uppercase, trailing newline); chain reader against the fixture (merge counted against its first parent, rename both paths, binary and mode detection); mirror create, seed, refspec, ref pruning and file-protocol gating; origin URL validator; isolation env and argv; `FIX_RUN_AS_USER` validation (the uid switch itself is not testable without privileges here); deploy log tail open; G1 repo choice.
- Property tests (fast-check 4.10.2, at least 100 runs, tagged `// Feature: fix-deploy, Property N`): Properties 1 to 10. Property 8 uses fewer runs because it spawns git, plus fixed edge cases.
- Route tests: the nine cases of Requirement 12.1 through the real route against the fixture origin (`LAB_ALLOW_FILE_ORIGIN=1`), plus 401 with the read token, 503 for an unreachable origin (a `file://` path that does not exist and an https URL to a closed port via a stub), idempotent second call, and the head-moved race (fixture ref moved between check and mutex via a test hook).
- Integration test: real supervisor process, fixture origin, `TRAFFIC_RPS=0`; apply `error-spike`, drive seeded charges and see about 30 % 500s; push the good fix; `deploy-fix`; drive charges again and assert the 500 delta ratio below 0.01 from payments `/metrics`; Deploy Record with `actor: "exorcist"`; diff of the fix served; reset returns all to `main`; the source checkout's `git worktree list` shows only itself.
- Permission risk check (task 4.1): a fix child under the exact flags starts, serves `/healthz` and `/metrics`, and fails to read a file outside the allowed paths and to spawn a process.
- `scripts/fix-deploy-check.mjs`: run by hand and by the Haunted Ops G-MVP gate against the real origin; not part of `pnpm test`.
- Verification: `pnpm install --frozen-lockfile && pnpm typecheck && pnpm lint && pnpm test && pnpm build`, and `node scripts/g1-check.mjs` in real-branch mode.
