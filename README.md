# Haunted Lab

A small, synthetic system that we break on purpose. Four services (`gate`, `orders`, `payments`, `ledger`), a supervisor with a chaos controller, and Prometheus. The Exorcist agent in [Haunted Ops](https://github.com/Akar-Samudra-Artifisial/Haunted-Ops) investigates the faults and proposes a fix as a pull request against this repo.

Everything here is fake: no real payments, no real data. The faults are planted on purpose on `scenario/*` branches.

Entry for Kiroween 2026. MIT licensed. See `.kiro/specs/haunted-lab/` for the spec; setup notes will live in `docs/DEV.md`.
