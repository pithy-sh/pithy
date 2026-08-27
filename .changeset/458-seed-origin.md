---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
---

A seed can ask where its own Worker answers.

`SeedPrepareContext` carried `env`, `project`, `secret`, `preferences` and `seeded`, and nothing that said what origin the environment would answer on. So a set that registers something pointing back at the app — a self-connection, a webhook target, an OAuth callback — had nothing to ask, and wrote the address down. The kit's own first adopter did exactly that: `const DEV_ORIGIN = "http://localhost:8787"`, under a comment predicting its own failure.

**The port is allocated, not configured.** Each checkout reserves a block and pins one port per Worker into `.dev.config.json`, which is the whole reason two features can run at once. That makes the literal right in the first checkout on a machine and wrong in every other one — a connection that registers cleanly, pings, and denies every real call. Worse when the first checkout is also running, because then the second one addresses the first one's Worker.

`context.origin` is that address, resolved from the allocation the run was actually given.

**Read back, never recomposed.** `buildDevConfig` mints `http://localhost:<port>` in exactly one place, and the seeder reads that string rather than composing a second one — two rules for one value is how the two disagree later. A test writes a config whose origin and port disagree and fails anything that recomputes it.

**An address, not an identity.** It says where to reach this Worker, on this machine, now. Nothing stored and verified later — an issuer, an audience, a signing scope — may be built from it, because the same project answers on a different origin in every checkout and every environment.

**`null` is an answer.** A clone that has never run `pithy dev`, a Worker added after the block was pinned, or any environment but `dev`: a deployed address is declared rather than allocated, and `pithy env` is what answers it. `resolveWorkerAddress` still returns `null` for `dev` for the same reason in reverse — a localhost URL is not a deployed Worker's address. A set that cannot work without an origin refuses and says so, because an invented one would be indistinguishable from a real one.

The acceptance test drives two real port allocations against one machine-wide registry and asserts the two runs see different origins, each equal to what its own checkout was pinned. No port literal appears in an assertion — a fixture that named one would pass against the defect.
