---
inclusion: always
---
# Product
Haunted Lab is a small system we break on purpose. The Exorcist agent in `haunted-ops` investigates the fault with read-only tools and proposes a fix as a pull request against THIS repo. Lab is the second public repo of the Haunted Ops entry (Kiroween 2026).
## Users
- The Haunted Ops api: the only client of the supervisor (chaos and observability routes) and of Prometheus.
- Judges watching the demo: they trigger a scenario and watch the Exorcist find the planted commit.
## Goals
- Three reproducible scenarios, each with a known culprit commit whose SHA is identical on every machine.
- Metrics always move: steady synthetic traffic.
- A reset to a healthy state at any time.
## Non-goals
- Real payments, real money movement, real customer data.
- Multi-tenant use, user accounts, a public API.
- Production-grade resilience. Services are small on purpose.
