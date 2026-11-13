# Requirements Document

## Introduction

Haunted Ops now opens AI-written fix pull requests against this repository. For each hunt it creates `incident/<huntId>` at the deployed scenario head D and pushes `exorcist/<huntId>` with one fix commit on top of D. The pull request goes `exorcist/<huntId>` -> `incident/<huntId>`, and a human merges it on GitHub. Haunted Ops then calls the lab to deploy the merged commit.

This spec adds that lab side: the route `POST /chaos/deploy-fix` with exactly the contract in `../haunted-ops/.kiro/specs/fix-proposal-flow/design.md`, section "Lab contract: `POST /chaos/deploy-fix` (external interface)"; a dedicated bare mirror for fetched refs so the developer checkout is never touched; a new allow-list; isolation of fix code, which is human-reviewed but AI-written and therefore untrusted; and the review leftovers that remain open. `main` and `scenario/*` never change; their SHAs stay pinned in `scripts/scenario-shas.json`.

Out of scope: the EC2 user, instance role and IMDS firewall rules (Haunted Ops `deploy-demo`), the pull request flow itself (Haunted Ops `fix-proposal-flow`), and any push to origin.

## Glossary

- **Supervisor**, **Lab**, **Service**, **Deploy**, **Deploy_Record**, **Deploy_Log**, **Worktree**, **Chaos_Controller**, **Observability_API**, **Plant_Script**: as in the `haunted-lab` spec.
- **Deploy_Fix_Route**: `POST /chaos/deploy-fix` on the Supervisor.
- **Contract**: the request and response table of the Deploy_Fix_Route in the Haunted Ops `fix-proposal-flow` design, copied into this spec's design.
- **Incident_Ref**: a branch name matching `^incident/c[a-z0-9]{24}$` (a CUID).
- **Fix_Sha**: the 40-hex commit the caller asks to deploy; it must be the head of the Incident_Ref.
- **Origin**: the Git remote the fixes come from, configured by `LAB_ORIGIN_URL` (default `https://github.com/Akar-Samudra-Artifisial/Haunted-Lab.git`).
- **Mirror**: the bare repository `data/repo.git` that the Supervisor deploys from and fetches into. Its `origin` is the Origin.
- **Source_Checkout**: the developer checkout the Supervisor runs from. It seeds the Mirror and is never fetched into or modified.
- **Allowed_Heads**: the commits of `main` and the three `scenario/*` branches in the Mirror, pinned by `scripts/scenario-shas.json` when that file exists.
- **Chain**: the first-parent commits from the Fix_Sha back to (not including) the first Allowed_Head, at most 20.
- **Fix_Child**: a Service process started from an Incident_Ref.
- **Fix_Worktree**: a Worktree created for a Fix_Sha.
- **Fix_User**: the OS user named by the optional `FIX_RUN_AS_USER`.
- **Manifest_File**: any file named `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json` or `yarn.lock`, at any path.
- **Origin_Fixture**: a local bare repository used as Origin in tests, built in a temp folder with fixed authors and dates.

## Requirements

### Requirement 1: Request validation and authentication

**User Story:** As the Haunted Ops api, I want the deploy-fix route to accept only a well-formed request with the chaos token, so that nothing else can trigger a deploy.

#### Acceptance Criteria

1. WHEN a request to the Deploy_Fix_Route does not carry `Authorization: Bearer <CHAOS_TOKEN>`, compared in constant time, THE Supervisor SHALL answer 401 and SHALL NOT read further, and `LAB_READ_TOKEN` SHALL NOT be accepted.
2. WHEN the body is larger than 8 KiB, THE Deploy_Fix_Route SHALL answer 400 with the code `bad_request` without reading the rest of the body.
3. WHEN the body is not a JSON object with exactly the keys `service`, `ref` and `sha`, or `service` is not one of `gate`, `orders`, `payments`, `ledger`, or `ref` does not match `^incident/c[a-z0-9]{24}$`, or `sha` does not match `^[0-9a-f]{40}$`, THE Deploy_Fix_Route SHALL answer 400 with the code `bad_request` and SHALL NOT run git.
4. THE body validator SHALL be total: for any input it SHALL return a valid request or a `bad_request` error and SHALL NOT throw.
5. THE Deploy_Fix_Route SHALL answer only with the Contract statuses 200, 400, 401, 404, 409, 422 and 503, and with 405 for a method other than POST.

### Requirement 2: Fetching the incident ref

**User Story:** As a lab operator, I want the lab to fetch only the one ref it was asked for, from a fixed public origin, so that a request cannot pull or run anything else.

#### Acceptance Criteria

1. WHEN a request is valid, THE Supervisor SHALL fetch only `refs/heads/<ref>` from the Origin into `refs/heads/<ref>` of the Mirror, with `--no-tags`, `--no-recurse-submodules` and `--end-of-options`, through `execFile` with an argument array, with a timeout of 30 s, and with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_TERMINAL_PROMPT=0` and `GIT_ALLOW_PROTOCOL=https`.
2. IF the Origin does not have the ref, THEN THE Deploy_Fix_Route SHALL answer 404 with the code `unknown_ref` and SHALL NOT deploy.
3. IF the Origin cannot be reached or a git call times out, THEN THE Deploy_Fix_Route SHALL answer 503 with the code `origin_unreachable`.
4. THE Supervisor SHALL accept as `LAB_ORIGIN_URL` only an `https:` URL with a host name, no user name, password, query or fragment, and a host that is not an IP address; an invalid value SHALL stop the Supervisor at start with the variable name only.
5. WHERE `LAB_ALLOW_FILE_ORIGIN=1` is set (tests only), THE Supervisor SHALL also accept an absolute `file://` URL as `LAB_ORIGIN_URL` and SHALL then allow the `file` protocol for fetches from it.
6. THE Supervisor SHALL run at most one fetch at a time; a second Deploy_Fix_Route request SHALL wait for the first fetch to finish.

### Requirement 3: Head and chain rule

**User Story:** As the Haunted Ops api, I want the lab to deploy only the reviewed head commit, and only when it sits on a pinned scenario or `main`, so that an unexpected commit is never deployed.

#### Acceptance Criteria

1. IF the Fix_Sha is not the head of the fetched Incident_Ref, THEN THE Deploy_Fix_Route SHALL answer 409 with the code `not_head`.
2. THE Supervisor SHALL walk the first-parent chain from the Fix_Sha, at most 20 commits, until it reaches an Allowed_Head.
3. IF no Allowed_Head is reached within 20 commits, THEN THE Deploy_Fix_Route SHALL answer 409 with the code `chain_too_long`; IF a root commit is reached first, THEN it SHALL answer 409 with the code `no_allowed_base`.
4. IF the Fix_Sha is itself an Allowed_Head, THEN THE Deploy_Fix_Route SHALL answer 409 with the code `empty_fix`.
5. WHEN `scripts/scenario-shas.json` exists in the Source_Checkout, THE Allowed_Heads SHALL be the recorded scenario SHAs and the Mirror's `main`, only after the record verifies (each scenario branch one commit on the recorded base, the base an ancestor of `main`, the SHAs equal); IF it does not verify, THEN THE Deploy_Fix_Route SHALL answer 503 with the code `lab_not_pinned`.
6. THE decision SHALL be made by a pure function `deployFixAllowed({ head, sha, chain, allowedHeads, service })` that does no I/O and returns either an acceptance or one status (409 or 422) with one code.

### Requirement 4: Content rules for the chain

**User Story:** As a lab operator, I want a fix to change only the source of the one service it fixes, in a small diff, so that AI-written code cannot change dependencies, other services or the supervisor.

#### Acceptance Criteria

1. IF any Chain commit, compared with its first parent (so that a merge commit counts), touches a path outside `services/<service>/`, THEN THE Deploy_Fix_Route SHALL answer 422 with the code `outside_service`; a rename SHALL count both its old and its new path.
2. IF any Chain commit adds, changes or deletes a binary file, a symlink (mode `120000`), a submodule (mode `160000`), or changes a file mode, THEN THE Deploy_Fix_Route SHALL answer 422 with the code `binary_or_special_change`.
3. IF any Chain commit touches a Manifest_File, THEN THE Deploy_Fix_Route SHALL answer 422 with the code `manifest_change`.
4. IF the total diff from the reached Allowed_Head to the Fix_Sha has more than 400 changed lines (added plus deleted), THEN THE Deploy_Fix_Route SHALL answer 422 with the code `diff_too_large`.
5. THE content rules SHALL be checked after the head and chain rule and only when the chain reached an Allowed_Head.

### Requirement 5: Deploying the fix

**User Story:** As a judge watching the demo, I want the merged fix to run in the lab and the deploy to be recorded, so that the haunting visibly ends.

#### Acceptance Criteria

1. WHEN a request is accepted, THE Supervisor SHALL, under the same mutex as apply and reset, check again that the Mirror's Incident_Ref still points at the Fix_Sha, and SHALL then deploy the Fix_Sha for the requested Service through the normal deploy path, leaving the other Services unchanged.
2. WHEN the deploy succeeds, THE Supervisor SHALL append one Deploy_Record with `actor: "exorcist"`, `ref` equal to the Incident_Ref and `sha` equal to the Fix_Sha, and SHALL answer 200 with `{ "deployId", "service", "sha" }`.
3. IF the Service already runs the same Incident_Ref at the same Fix_Sha, THEN THE Supervisor SHALL answer 200 with the existing Deploy_Record id and SHALL NOT restart the Service.
4. IF the deploy fails after acceptance, THEN THE Deploy_Fix_Route SHALL answer 503 with the code `deploy_failed` and THE previous child SHALL keep running.
5. WHEN `POST /chaos/reset` or a scenario apply runs after a fix deploy, THE Supervisor SHALL replace the Fix_Child exactly as it replaces any other child, and reset SHALL return every Service to `main`.
6. WHEN `GET /chaos/state` is called, THE Supervisor SHALL show the Incident_Ref and Fix_Sha for a Service running a fix.

### Requirement 6: Mirror and worktree hygiene

**User Story:** As a developer, I want fetched refs and fix worktrees to stay out of my checkout and to be cleaned up, so that my repository stays clean.

#### Acceptance Criteria

1. THE Supervisor SHALL deploy from and fetch into the Mirror only, and SHALL NOT fetch into, create refs in, or change the working tree or index of the Source_Checkout.
2. WHEN the Supervisor starts and the Mirror does not exist, THE Supervisor SHALL create it as a bare clone of the Source_Checkout, SHALL set its `origin` to `LAB_ORIGIN_URL`, and SHALL set the `origin` fetch refspec to `+refs/heads/incident/*:refs/heads/incident/*` only.
3. WHEN the Supervisor starts, THE Supervisor SHALL update the Mirror's `main` and `scenario/*` from the Source_Checkout and SHALL set `origin` to the configured `LAB_ORIGIN_URL`.
4. THE Worktrees SHALL be registered to the Mirror; WHEN the Supervisor starts, it SHALL remove the lab worktrees under the worktrees directory that are still registered to the Source_Checkout and SHALL run `git worktree prune` on the Source_Checkout, so that `git worktree list` there shows only the checkout.
5. WHEN the Supervisor starts and after every Deploy, THE Supervisor SHALL remove every Fix_Worktree that is not deployed and was last used more than 1 h ago, through `git worktree remove --force` and `git worktree prune`; scenario and `main` Worktrees SHALL keep their existing rule (only the active one per Service).
6. THE Supervisor SHALL keep at most the 50 most recently fetched Incident_Refs in the Mirror and SHALL delete older ones locally only, never on the Origin.
7. THE Mirror SHALL live under `data/`, which is git-ignored.

### Requirement 7: Allow-list

**User Story:** As a lab operator, I want one clear rule for which refs can run, so that fix branches can only run through the checked route.

#### Acceptance Criteria

1. THE Supervisor SHALL deploy `main` and the three `scenario/*` branches by name (boot, apply, reset).
2. THE Supervisor SHALL deploy an Incident_Ref only through the Deploy_Fix_Route.
3. THE Supervisor SHALL deny every other ref, including `exorcist/*`, and apply, reset and boot SHALL never deploy an Incident_Ref.
4. THE ref classifier SHALL return `named` for `main` and the three `scenario/*` branches, `fix` for an Incident_Ref, and `denied` for anything else.

### Requirement 8: Diffs of fix commits

**User Story:** As the Exorcist agent, I want to read the diff of a deployed fix, so that I can confirm what runs.

#### Acceptance Criteria

1. WHEN `GET /lab/commits/{sha}/diff` is called, THE Observability_API SHALL serve commits reachable from `main`, the three `scenario/*` branches and the Incident_Refs present in the Mirror, and SHALL answer 404 `unknown_commit` for any other commit.
2. THE diff of a fix commit SHALL keep the existing size cap, pathspec, field cleaning and `"untrusted": true` marker.

### Requirement 9: Isolation of fix code

**User Story:** As a lab operator, I want merged fix code to run with as little access as possible, so that AI-written code cannot read the supervisor's secrets or act outside its service.

#### Acceptance Criteria

1. THE Supervisor SHALL give a Fix_Child an env built only from a whitelist: its own port variable, `SERVICE_BIND_HOST`, its downstream URL variable (derived from the ports), `NODE_ENV=production` and a fixed `PATH=/usr/bin:/bin`, and SHALL NOT pass `CHAOS_TOKEN`, `LAB_READ_TOKEN` or any other Supervisor variable.
2. THE Supervisor SHALL start a Fix_Child with `node --permission`, with `--allow-fs-read` only for its Fix_Worktree, the Source_Checkout's `node_modules` and the Source_Checkout's `packages/lab-common`, and with `--allow-net`.
3. THE Supervisor SHALL NOT pass `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-ffi` or `--allow-inspector` to a Fix_Child.
4. WHERE `FIX_RUN_AS_USER` is set, THE Supervisor SHALL accept only a name matching `^[a-z_][a-z0-9_-]{0,31}$`, SHALL resolve its uid and gid through `execFile('id', ...)` at start, SHALL refuse uid 0 and its own uid, and SHALL spawn every Fix_Child with that uid and gid.
5. WHERE `FIX_RUN_AS_USER` is set, WHEN the Supervisor starts, it SHALL spawn a probe child as the Fix_User and SHALL exit with code 1, naming only `FIX_RUN_AS_USER`, if the probe cannot start.
6. WHERE `FIX_RUN_AS_USER` is not set, THE Supervisor SHALL log once at start that fix code runs as the Supervisor's own user and that this is for development only.
7. THE Supervisor SHALL start `main` and `scenario/*` children as before.

### Requirement 10: Protection of supervisor secrets

**User Story:** As a lab operator, I want the supervisor's tokens to be unreadable by fix code, so that a hostile fix cannot take over the chaos or read routes.

#### Acceptance Criteria

1. WHERE `FIX_RUN_AS_USER` is set on Linux, THE Fix_User SHALL NOT be able to read `/proc/<supervisor pid>/environ`, because the Supervisor runs as a different uid and the kernel's ptrace access check refuses it; the design SHALL document this and the additional `hidepid` / `ProtectProc` setting done in `deploy-demo`.
2. THE Supervisor SHALL create `data/` (Deploy_Log, `pids.json`, Mirror) with mode `0700`, so that the Fix_User cannot read it.
3. THE design SHALL state what the Mac gets (Node permission model only, same OS user) and what EC2 gets (separate OS user, no instance role, IMDS blocked for that user), and that the EC2 part is done in Haunted Ops `deploy-demo`.

### Requirement 11: Review leftovers

**User Story:** As the orchestrator, I want the open review items closed, so that the lab gate and the deploy log behave as intended.

#### Acceptance Criteria

1. WHEN `scripts/scenario-shas.json` verifies against this repo and `main` contains the services, THE `scripts/g1-check.mjs` SHALL run against this repo's real scenario branches and SHALL say so; otherwise it SHALL build the snapshot repo and SHALL print why.
2. WHEN the Supervisor opens the Deploy_Log, it SHALL read only the end of the file (at most 256 KiB, reading further back only until one valid record is found) to find the next id and fill the in-memory tail, so that memory stays bounded whatever the file size.
3. THE existing behaviour SHALL stay covered by tests: placeholder (`change-me*`) and equal tokens refused at start; untrusted fields bounded before path stripping; every absolute path stripped from frames; diffs limited to `-- services packages`; a timeout on `commitDiff`; `.gitignore` entries for `.DS_Store`, `*.pem` and `coverage/`.

### Requirement 12: Tests and the fix-deploy check

**User Story:** As the orchestrator, I want automated proof that a real fix deploys and ends the fault, so that the Haunted Ops G-MVP gate can rely on it.

#### Acceptance Criteria

1. THE unit and property tests SHALL use an Origin_Fixture with fixed authors and dates, and SHALL cover a good fix, a merge fix, a squash fix, a chain that touches another service (422), a sha that is not the head (409), an unknown ref (404), a changed `package.json` (422), a 21-commit chain (409) and a ref name injection attempt (400).
2. AN integration test SHALL start the Supervisor with the Origin_Fixture as Origin, apply `error-spike`, push an `incident/<cuid>` fix to the Origin_Fixture, call the Deploy_Fix_Route, assert through the payments `/metrics` that the error ratio returns below 0.01, and assert that reset returns every Service to `main`.
3. THE `scripts/fix-deploy-check.mjs` SHALL, given `REF` and `SHA`, start a Supervisor with a temporary data directory against the real GitHub Origin, apply the scenario whose head the chain reaches, call the Deploy_Fix_Route, assert that the scenario's signal returns to healthy through the Service's `/metrics` or `/healthz`, reset, print a table and exit 0 or 1.
4. THE `scripts/fix-deploy-check.mjs` SHALL never push, SHALL generate throwaway tokens it never prints, and SHALL stop everything it started.
5. THE `docs/DEV.md` SHALL describe the Mirror, `LAB_ORIGIN_URL`, `FIX_RUN_AS_USER`, the Deploy_Fix_Route and the check script, with env names only.
