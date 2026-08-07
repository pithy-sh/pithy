---
"@pithy-sh/secrets": minor
---

Secrets get their own dev file, versioned exactly as they are stored.

`.dev.vars` carried two namespaces with nothing to tell them apart: wrangler's `UPPER_SNAKE` env bindings and the Secrets Store's kebab `<capability>-<what>`. Both conventions are right in their own namespace, and sharing one file made each look like a mistake.

`@pithy-sh/secrets` now ships the format and the machinery behind `.dev.secrets.jsonc`: a Zod schema for the file, a loader that validates it at the boundary, and a seeder that derives every secret's destination from the registry's `backend` — a `d1` secret becomes an encrypted row in the local `SECRETS` D1, a `cf-secrets-store` secret comes back as the `.dev.vars` line the CLI should write. Nothing in the file names a destination, so the file and the registry cannot disagree.

Every value is a full `{ currentVersion, versions }` envelope, never a bare value. That is what makes the format unambiguous: with optional envelopes a JSON-valued secret's own object cannot be told apart from an envelope without a marker or a heuristic. It also matches what is actually stored, so dev stops being a shape production never sees.

Seeding is idempotent. A secret already stored with the value the file states is left untouched — no re-encrypt, no `updatedAt` churn — and a secret already in the file is never re-minted, because a fresh session key invalidates every live session. A registry entry with `devValue` that the file has no value for is minted, seeded, and returned for write-back as a version-1 envelope.

A malformed file, a bad envelope, or a value that fails its registry schema is a `validation/invalid_input` naming which secret and what to do. No value ever reaches the message, the action, or the detail.
