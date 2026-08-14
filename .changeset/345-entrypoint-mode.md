---
"@pithy-sh/cli": patch
---

`bun install` left the CLI entrypoint world-writable.

`packages/cli/src/bin.ts` came out of every install at `0777`. `pithy` is the only `bin` in the workspace, `tooling/browser-scopes` depends on `@pithy-sh/cli`, and bun links a workspace bin by symlinking `node_modules/.bin/pithy` straight at the source file — then makes the target executable with a mode nobody chose. `rwxrwxrwx` on the program that reads an adopter's dev secrets and holds their Cloudflare credentials: any local account could rewrite it, and the next `pithy` the user ran was whatever that account wrote. git recorded the file `100644`, so it also reported a mode change in every worktree from the moment it was cut — six of thirteen on one machine at once, and a tree that is dirty by default is how an unrelated change gets swept into somebody's commit.

The exec bit is wanted. `bin.ts` opens `#!/usr/bin/env bun`, and bun's workspace link points at the source rather than at a shim, so `./node_modules/.bin/pithy` is `Permission denied` without it. So git now records `100755`, and the repo root's `postinstall` narrows what the install widened: the same command that breaks the mode repairs it, which is why a worktree already carrying the change is fixed by re-running `bun install` rather than by hand.

The rule is stated once, in `src/ci/fileModes.ts`, and gated in `src/ci/fileModes.test.ts` over everything git tracks or the tree holds unignored. No file is world-writable, none carries setuid, setgid or sticky, the exec bits agree with what git records, and a file git records executable is not group-writable either — the three programs something else runs by path land at `0755`. Group-write is permitted elsewhere because `git checkout` writes `0664` under a `0002` umask, and a gate red on files git itself just wrote is a gate muted within a day. A mode git records that this rule has no sentence about throws rather than being skipped.
