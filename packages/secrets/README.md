# @pithy-sh/secrets

Encrypted secret storage for Pithy. One dedicated D1 per environment, a worker-only
master key in CF Secrets Store, automatic at-rest key rotation, and the `pithy secrets`
CLI to manage it.

Secrets live in their own `SECRETS` database — separate from the app `DB`, because the
app database is ephemeral per feature branch and secrets are durable and shared. Each
environment binds only its own store and key. Reads are local; writes go through the
per-environment secrets manager.

See the package source for the `SecretRegistry`, the `secretsStore` read seam, and the
capability wiring. Adoption is never gated behind Bun: this package is pure ESM on Node 22+.
