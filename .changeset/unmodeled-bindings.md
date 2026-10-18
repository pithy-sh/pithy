---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
---

An app declares the Cloudflare bindings it needs — Hyperdrive, Browser Rendering, Images, Analytics Engine, Queues and more — and the kit writes them, provisions what it owns, and carries them into every environment, features included.

Security: `pithy feature destroy` runs headlessly in CI against a branch anyone can push, and its manifest is repository content. Each entry is trusted for its name alone: the id deleted is the account's answer for that name, so a crafted entry cannot reach production's queue, database or namespace by id.
