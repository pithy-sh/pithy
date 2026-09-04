---
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/core": patch
"@pithy-sh/payments": patch
"@pithy-sh/support": patch
"@pithy-sh/cli": patch
---

Nine gates were green and could not fail. Each is now planted against and watched failing.

They are one class, not nine bugs. A census of every test claiming a repo-wide or capability-wide invariant found eight shapes, and the two most common are the same mistake at different altitudes: a check derived from its own subject, and a set under test computed by calling the function under test. The taxonomy is written down in `packages/cli/src/ci/sweepPopulation.test.ts`, where the next gate author will meet it.

**auth and support declare admin routes and asserted only one direction.** Five capabilities assert both. A route mounted with `requireControlPlane` and never declared was invisible to `missingAdminRoutes`, so a management surface could grow without ever reaching the manifest a client dispatches from. Both now probe the router with a credential-free request and hold the set that answers `controlplane/not_connected` against what the manifest declares — method and path, read from behavior rather than from the declaration under test.

**payments pinned its route table by path.** `POST /payments/admin/purchases` beside the read was a write nobody declared and this file could not see: the path was already in the set, and a set does not count. Pinned by method and path now, as email's has been.

**The store-backed-secret scan could not see a hyphenated, quoted or standalone declaration.** It found one of the two the kit ships and its anti-vacuity guard was `> 0`. It is driven off a text count now, every declaration must be named, and a shape the extractor cannot read raises instead of vanishing.

**The mint-coverage gate named four registries and said it read them all.** Eight ship. The list is held against a scan of the packages, so a ninth `defineSecretRegistry` fails until somebody says what creates its arbitrary secrets.

**The schema-description sweep walked object fields and stopped.** An object inside an array, an optional, a record or a union member was never reached. It follows every container Zod has, a kind it does not know throws rather than passing as a leaf, and it counts what it swept.

**`requiredBindings` quantified fifteen manifests it never asserted it had.** With an empty walk the file collapses from 36 tests to 6 and stays green.

**The core Worker-safety scan saw only `node:` specifiers**, with a floor of 20 against 104 modules. `import { createHash } from "crypto"` is a Node builtin and was invisible. Stated positively now: every specifier is relative or a declared dependency.

**The one-printer JSONC gate matched two spellings of a write verb.** `writeFileSync` was not one of them. The write half is gone; what is checked is who can reach `comment-json`'s `stringify` at all.

**The contract module's "no timer, no fetch, nothing from node" was four literals.** `setInterval` was not among them. The imports are an allowlist and the forbidden ambient names are the runtime's own globals, so the list cannot come out shorter than the rule.

And a gate over the gates: every package-wide `import.meta.glob` sweep is partitioned into the ones that assert their population and the seventeen that do not. A new sweep is in neither list and fails there.
