---
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
"@pithy-sh/storage": patch
---

`ensureOurs` argues from arrangements that still exist. Two of its three did not.

The docstring justified following a symlink at all with three worked examples. Two of them described a repository that is gone: `apps/<worker>/.dev.vars` as a link to a shared project file, and a worktree's root `.dev.vars` as a link to the main checkout's, made by `scripts/worktree.ts`. #154 replaced the first with generation and removed the second, along with the `vars:local` task the same paragraph cited. Nothing in this repository creates a symlink now.

A correct rule arguing from cases a reader cannot find is how a correct rule comes to look unjustified, and gets weakened by someone tidying up. So the citations are replaced, not the rule.

What replaces them is stronger than the examples were. Because the kit makes no links at all, every link the walk can meet is the adopter's own — beside a planted one that is indistinguishable from it by destination. There is no arrangement of ours left to recognise by shape. And location cannot classify either: the writes that land in `<config>/<project>/` are outside every checkout by design (#156), so there is no project root available to contain to, and one that existed would refuse the adopter's link along with the planted one.

#146 stays, as what it is — the failure a rename over a link produces, which is why the choice is follow or refuse and never replace. A citation of a fixed defect does not rot the way a citation of a live arrangement does. `resolveWritePath`'s `apps/` reference (#147) is the same kind, and stays for the same reason.

The same two citations had five producers, not one, so all five are fixed rather than the first. `atomic.test.ts` argued the containment rule from `scripts/worktree.ts` in three comments; `project/devVars.ts` described writing "through the shared file's symlink". Fixing one and filing the rest is the enumerating habit that gave this class six producers already.

**Two of the five were not stale prose but instructions that fail when followed.** `packages/cloudflare/README.md` and `packages/storage/README.md` told a reader to run `bun run vars:local` before the live suites. That task was deleted with everything else in #154 — it is in no `package.json` and in no `turbo.jsonc`, so the documented first step exits non-zero. Both now say what actually supplies credentials: `packages/cloudflare/.dev.vars`, a real file nothing creates, with `process.env` overlaid per key for whatever it does not set. Neither `pithy dev` nor `pithy seed` fills that gap — `apps/` is the registry, so generation reaches an adopter's Workers and never a kit package.

The storage README carried a second error the first one hid, and it named the wrong package. Its live suites take credentials from `loadIntegrationCreds` in `@pithy-sh/cloudflare`, and that reads the `.dev.vars` beside *itself* — so a file in `packages/storage/` is read by nothing, whatever put it there. Anyone who followed the old step and wrote one got no error saying so, just a suite that skipped for want of credentials it was standing next to. The section now names `packages/cloudflare/.dev.vars`, and the harness says the same thing at the line that computes the path.

No behaviour change. The ownership rule, its two accepted limits, and every test assertion are untouched; `docs/ACCEPTED-LIMITS.md` remains where the limits are argued.
