---
inclusion: always
---
# Structure
```
services/
  gate/ orders/ payments/ ledger/   one call chain: gate -> orders -> payments -> ledger
supervisor/                          runner, traffic, chaos controller (incl. deploy-fix), observability API
packages/
  lab-common/                        shared http helpers, metrics, rings, config
scripts/
  plant-scenarios.mjs                creates scenario/* branches with stable SHAs
  scenario-shas.json                 pinned { base, shas } of the scenario branches
  g1-check.mjs                       Gate G1 end to end check
  fix-deploy-check.mjs               deploys a real merged fix and checks it ends its scenario
deploy/
  prometheus.yml  compose.yaml  compose.linux.yaml  targets/
docs/
  DEV.md  KIRO_USAGE.md
.kiro/
  steering/ hooks/ specs/haunted-lab/ specs/fix-deploy/
data/                                runtime, git-ignored, 0700: deploys.jsonl, pids.json, repo.git (bare mirror)
worktrees/                           runtime, git-ignored (<service>@<sha>, registered to data/repo.git)
spike/                               local working briefs only, git-ignored
```
Branches: `main` (healthy), `scenario/error-spike`, `scenario/fog`, `scenario/dark-room` (one planted commit each on top of `main`, pinned in `scripts/scenario-shas.json`). On GitHub, Haunted Ops creates `incident/<huntId>` at the deployed scenario head and `exorcist/<huntId>` with one fix commit; the lab only fetches `incident/*`, into `data/repo.git`.
Specs: `.kiro/specs/haunted-lab/` (done), `.kiro/specs/fix-deploy/`. Write code through their tasks.
