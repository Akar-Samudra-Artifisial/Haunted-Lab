---
inclusion: always
---
# Tech
Package manager: pnpm only. Runtime: Node 26. Language: TypeScript, strict. Tests: Vitest + fast-check.
## Stack
- `services/{gate,orders,payments,ledger}`: plain `node:http`, `prom-client` on `/metrics`, bounded in-memory error and log rings.
- `supervisor/`: child process runner on git worktrees, deploy log, traffic generator, chaos controller, read-only observability API.
- `scripts/`: `plant-scenarios.mjs`, `g1-check.mjs`.
- `deploy/`: `prometheus.yml`, `compose.yaml` (docker compose on Mac, podman compose on EC2).
## Decisions
- No web framework: four tiny services; `node:http` keeps the culprit diffs small and readable.
- Rings in memory: no database, a restart clears them, which matches a deploy.
- Git worktrees per `<service>@<sha>`: a deploy is a ref checked out and started, so the deploy log and the diff API agree with what runs.
- Fixed author, committer and dates on planted commits: SHAs are stable across machines.
- Prometheus is the metrics source; the supervisor serves only errors, logs, deploys and diffs.
- `execFile` with argument arrays for git, never a shell string.
## Rejected alternatives
- Express / Fastify / Nest: more code, noisier diffs.
- Docker-per-service: slower restarts, needs a daemon for the crash loop scenario.
- A database or log shipper for errors and logs: not needed for a demo lab.
- Deploying refs from request bodies: arbitrary code execution; allow-list only.
- npm / yarn: pnpm only.
