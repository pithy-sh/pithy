---
"@pithy-sh/cli": patch
---

A real `.dev.vars` is never replaced by a link.

`wireFeatureDevVars` deleted whatever it found at a target and symlinked over it. Every caller wires *every* worker it discovers, so a command touching one worker rewrote the `.dev.vars` of all of them: `pithy worker add web` in a project whose `apps/board/.dev.vars` held a secret of its own replaced that file with the root file's contents, exited 0, and said nothing. `.dev.vars` is gitignored, so what went was the only copy anywhere.

The policy is now the one the file deserves. A symlink is replaced freely — that is what makes re-running idempotent and re-points a worktree after a rename, and a link holds nothing that is not in the file it points at. A regular file is left exactly as it is and reported back in `kept`, so the adopter is told rather than robbed.

`pithy init` reached the same loss by a second route: the two `.dev.vars` paths it writes were invisible to its collision check, which is walked from the template, and the template ships only `.dev.vars.example`. A pre-existing `apps/<worker>/.dev.vars` is now named as a collision and the run refuses before writing anything.

Two more things about that file, both found in the same review:

- It is created `0600`. `cp` copies the template's mode, so the project's one credential file landed `0664` whatever the umask said — before `pithy add` and `pithy token mint` write `CLOUDFLARE_API_TOKEN` and `SECRETS_ENCRYPTION_KEYS` into it.
- The link is relative wherever one can reach. An absolute link dangles under `mv`, `cp -a`, rsync or a Docker build context, and wrangler then reports every secret absent while the file sits right there.
