---
inclusion: fileMatch
fileMatchPattern: "{supervisor/**,scripts/plant-*}"
---
# Chaos and scenarios
- The chaos controller is the only way to inject a fault. `POST /chaos/reset` redeploys `main` for every service.
- Scenarios (one commit each on top of `main`): `error-spike` (payments, removes a null guard, ~30% throw), `fog` (orders, slow sequential call, p95 > 1.5 s, no errors), `dark-room` (ledger, reads a renamed env var, exits at start, crash loop, `up` = 0).
- Planted commits use a fixed author, committer and dates. The plant script is idempotent and a test asserts the three SHAs. If a change to `main` moves a SHA, update the expected values and the plant script together.
- Deploy only allow-listed refs. Deploys go through `execFile` with argument arrays; never use a ref or path from a request body.
- Every deploy is appended to `data/deploys.jsonl` (append-only).
- Crash restarts use backoff; a crash loop must not spin the CPU.
