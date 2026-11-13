---
inclusion: fileMatch
fileMatchPattern: "{supervisor/**,scripts/plant-*}"
---
# Chaos and scenarios
- The chaos controller is the only way to inject a fault. `POST /chaos/reset` redeploys `main` for every service.
- Scenarios (one commit each on top of `main`): `error-spike` (payments, removes a null guard, ~30% throw), `fog` (orders, slow sequential call, p95 > 1.5 s, no errors), `dark-room` (ledger, reads a renamed env var, exits at start, crash loop, `up` = 0).
- Planted commits use a fixed author, committer and dates. The plant script is idempotent and a test asserts the three SHAs. If a change to `main` moves a SHA, update the expected values and the plant script together.
- Deploy only allow-listed refs. Deploys go through `execFile` with argument arrays; never use a ref or path from a request body.
- Allow-list (spec `fix-deploy`): `main` and the three `scenario/*` branches are deployable by name (boot, apply, reset); `incident/<cuid>` (`^incident/c[a-z0-9]{24}$`) only through `POST /chaos/deploy-fix`; everything else, including `exorcist/*`, is denied.
- `POST /chaos/deploy-fix` follows the Haunted Ops contract exactly (200, 400, 401, 404, 409, 422, 503): fetch only that ref, `sha` must be its head, the first-parent chain (at most 20) must reach a pinned scenario head or `main`, every commit (merges against their first parent) touches only `services/<service>/`, no binary, symlink, mode or manifest change, at most 400 lines. The decision is the pure `deployFixAllowed`. It deploys under the same mutex as apply and reset, with a Deploy Record `actor: "exorcist"`.
- The supervisor deploys from the bare mirror `data/repo.git` (seeded from the checkout, fetching only `incident/*` from `LAB_ORIGIN_URL`). Never fetch into the developer checkout.
- Every deploy is appended to `data/deploys.jsonl` (append-only).
- Crash restarts use backoff; a crash loop must not spin the CPU.
