---
"@pithy-sh/cli": minor
---

Long commands narrate themselves.

`pithy deploy` printed nothing at all until it had finished. For minutes, while it built front ends and
uploaded Workers. Someone who knows the command works waits it out; someone who does not cannot tell a
slow upload from a hung one, and the first thing they reach for is Ctrl-C in the middle of a deploy.

This was solved once already, for `pithy provision` (#515, #531) — and `deploy` never inherited it,
because the seam was called `ProvisionProgress` and lived in `provision/environment.ts`. Nothing about
either said *this is how a long command narrates itself*. It said *this is how provisioning narrates
itself*, which is why the second long command decided the question again and decided it differently.

So the vocabulary moved to `terminal/progress.ts`, under no capability and no command, and it is ambient
rather than threaded. A producer raises a step; the span decides whether anyone hears it. That is what
lets `capabilities/hostDeploy.ts` — the one path every kit Worker is deployed through — narrate the
upload for `pithy deploy --kit` **and** for every `pithy <capability> provision`, through two kit
packages that carry no progress parameter and should not grow one.

`withErrorReporting` opens the span, which is the wrapper every command body already runs inside. A
command written next year narrates without deciding to.

**The gate is `--json`, and only `--json`.** A machine reads exactly one line, exactly as it did. It is
deliberately not the TTY: a run in CI is the run whose log most needs to say where it got to, and these
are plain lines printed once and never redrawn — no spinner, no cursor movement — so a redirected stdout
takes them unharmed.

**A human `pithy deploy`'s output shape changed.** The per-Worker line each Worker settles as is printed
as that Worker settles rather than in a block after the last upload; it **moved**, so it is not printed
twice, and the same is true of each kit capability's row. The migration warning now comes first, before
the first upload. The `--json` payload, its keys, and every exit code are unchanged.

Fixes #578.
