---
inclusion: always
---
# Structure
```
services/
  gate/ orders/ payments/ ledger/   one call chain: gate -> orders -> payments -> ledger
supervisor/                          runner, traffic, chaos controller, observability API
packages/
  lab-common/                        shared http helpers, metrics, rings, config (planned)
scripts/
  plant-scenarios.mjs                creates scenario/* branches with stable SHAs
  g1-check.mjs                       Gate G1 end to end check
deploy/
  prometheus.yml  compose.yaml
docs/
  DEV.md  KIRO_USAGE.md
.kiro/
  steering/ hooks/ specs/haunted-lab/
data/                                runtime, git-ignored (deploys.jsonl)
worktrees/                           runtime, git-ignored (<service>@<sha>)
spike/                               local working briefs only, git-ignored
```
Branches: `main` (healthy), `scenario/error-spike`, `scenario/fog`, `scenario/dark-room` (one planted commit each on top of `main`), `exorcist/*` (reserved for fix branches).
One spec: `.kiro/specs/haunted-lab/`. Write code through its tasks.
