# Kiro usage log
One line per finished task: date | spec/task | what Kiro did.
- 2026-11-13 | haunted-lab/setup | Kiro created the repo skeleton, 6 steering files, 4 hooks and the haunted-lab spec.
- 2026-11-13 | haunted-lab/1 | Kiro set up package skeletons, strict tsconfigs with erasable syntax, and confirmed services run from git worktrees with symlinked node_modules.
- 2026-11-13 | haunted-lab/2 | Kiro built lab-common (env parsing, rings, metrics, node:http server, bearer compare, client) with property tests 1, 2, 3, 10, 15.
- 2026-11-13 | haunted-lab/9 | Kiro wrote the Prometheus config, file targets and compose file, and verified colima reaches host loopback via host-gateway.
- 2026-11-13 | haunted-lab/3 | Kiro implemented gate, orders, payments and ledger with chain and baseline tests, and replaced fetch with node:http after finding a 300 ms keep-alive delay.
- 2026-11-13 | haunted-lab/4 | Kiro implemented the jittered traffic generator with an in-flight cap and property tests 12 and 16.
- 2026-11-13 | haunted-lab/5 | Kiro implemented supervisor config, refs, git, worktrees, deploy log and runner with backoff, with property tests 4, 5, 6, 13.
- 2026-11-13 | haunted-lab/6 | Kiro wrote the deterministic plant script and snapshot repo builder, with exact-SHA tests and property test 11.
- 2026-11-13 | haunted-lab/7 | Kiro implemented the chaos controller (boot, apply, reset, state, mutex, reserved refs) with property test 14 and a real-process integration test.
- 2026-11-13 | haunted-lab/8 | Kiro implemented the observability API (errors, logs, deploys, diffs, caps) with property tests 7, 8, 9.
- 2026-11-13 | haunted-lab/10 | Kiro wrote g1-check.mjs and ran it on this Mac: all three scenarios detected and recovered within 30 s.
- 2026-11-13 | haunted-lab/11 | Kiro wrote DEV.md and .env.example, scanned for secrets and home paths, and ran the full install, typecheck, lint, test and build chain.
- 2026-11-13 | haunted-lab/12 | Kiro applied the code and security review fixes (plant record check and dates, token rules, process groups and stale pids, worktree cleanup, git isolation, untrusted /lab data, zeroed counters, Linux host-network compose) with tests, and re-ran G1.
