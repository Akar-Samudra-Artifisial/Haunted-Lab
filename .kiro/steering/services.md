---
inclusion: fileMatch
fileMatchPattern: "services/**"
---
# Services
- Call chain: `gate` -> `orders` -> `payments` -> `ledger`. `gate` is the entry.
- Plain `node:http`. No web framework. `prom-client` metrics at `/metrics`: `http_requests_total{route,code}` and the `http_request_duration_seconds` histogram. `up` comes from the Prometheus scrape.
- Error ring (last 200: time, message, first stack frame, request id) and log ring (last 500 lines) are bounded, in memory, read-only over HTTP.
- Use the `route` label with route templates, never raw paths (bounded cardinality).
- Healthy `main` is the baseline: no errors, p95 about 40 ms. The scenario commits patch specific lines; keep those lines stable (see `chaos.md`).
- Config from env with defaults; a missing required name exits with the NAME only, never values.
- Synthetic data only.
