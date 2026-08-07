---
"@pithy-sh/cli": patch
---

`pithy worker add` produces a worker that installs, and leaves nothing behind when it cannot.

The literal `"@pithy-sh/core": "^0.0.0"` that `pithy init` stopped writing was still live in the second Worker producer, so every worker after the first 404'd on the install this command runs. Three failures came out of that one line, and all three are fixed.

The range is now `kitRange(PACKAGE_VERSION)`, the same rule `pithy init` follows — nothing written while the scope is unpublished, the real range the day it is.

The install runs **last**. It used to run first and throw, and the `.dev.vars` wiring below it never ran — so every added worker was missing the symlink `pithy init` gives every worker. Ordering settles it: by the time an install can fail, there is nothing left for it to skip.

A failed run rolls `apps/<name>` back. `pithy worker add` refuses a directory that holds anything, so a half-made worker blocked its own retry and `rm -rf` by hand was the only way out. It is all-or-nothing now, and the same command works on the retry.

The added worker's `package.json` also matches the starter's again: Node floor, `deploy:staging` and `deploy:prod`, `@cloudflare/workers-types@^5.20260729.1` and `wrangler@^4.115.0` — a major and sixteen minors behind, in the producer nobody re-reads. `scaffoldParity.test.ts` now covers `package.json` as well as `wrangler.jsonc`, which is what will catch the next drift.
