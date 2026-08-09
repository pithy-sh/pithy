---
"@pithy-sh/cli": patch
---

`PITHY_OFFLINE` no longer changes what a unit test says.

#218 added the variable so a developer or an agent can stop worrying about reaching a real account, and
this repository recommends it. Setting it turned a suite red: `PITHY_OFFLINE=1 bunx vitest run
src/doctor/probeAccountEvidence.test.ts` reported four failures that a plain run does not, and one more
in `src/commands/add.test.ts`. Under turbo, as CI runs it, nothing sets the variable and everything
passed. **A guard that silently changes a test outcome teaches people not to use it** — and it had
already cost a false report, an agent naming those four as pre-existing breakage on `main`, which they
were not.

**The gate was not at fault, and that was established before anything changed.** `PITHY_OFFLINE` refuses
the `process.env` credential overlay and nothing else; a resolution handed its own `env` through the
seam reads that object, so a test supplying credentials through a seam is untouched. Both suites supply
theirs through the overlay — `vi.stubEnv("CLOUDFLARE_API_TOKEN", "tok")` — because the credentials left
the checkout in #182 and the overlay is the other real supply route. Offline refusing them is offline
working. Every other suite in the tree was checked the same way and none is affected.

So the fix is where #198's already was: the unit configs pin it. `NO_ACCOUNT` in `vitest.shared.ts` now
carries `PITHY_OFFLINE: ""` beside the four blanked credential keys, for the same sentence — **a unit
result is a fact about the code, not about the shell it ran in.** Blank is not offline, matching how the
overlay itself reads a blank value. Integration configs state neither: reaching a real account is what
they are for, and offline is the one thing that legitimately stops them.

The name is spelled in `vitest.shared.ts` rather than imported from the CLI that owns it, and that is a
cost rather than a preference: vite's config loader externalises bare specifiers, so importing
`cloudflare/config` reaches `@pithy-sh/core`'s error module externalised and node cannot resolve its
extensionless relative import — every config in the tree fails to load before a test runs. The copy is
not gated yet, and the constant says so: the assertion belongs in `ci/testIsolation.test.ts`, which loads
every config already and can import the real name because a test file is transformed rather than
externalised.

`probeAccountEvidence` now asserts the offline case rather than depending on its absence: with the pair
still exported, offline probes no account and claims nothing. `CONTRIBUTING.md` recommends
`PITHY_CONFIG_DIR` and `PITHY_OFFLINE=1` together, without a caveat.
