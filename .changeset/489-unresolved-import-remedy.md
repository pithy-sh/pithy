---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
"@pithy-sh/vite": patch
---

A config that will not load tells you which of three things went wrong.

An unresolvable import used to get one sentence whatever the cause: *Install the project's dependencies (bun install), or correct that import.* For a missing dependency that is right. For the other two — a package that is installed but does not provide the subpath, and a relative import of your own file — `bun install` is guaranteed to change nothing, so the advice cannot be followed and following it teaches you nothing.

The three now read differently, and two of them say plainly that installing will not help:

```
Nothing provides "some-package". Install the project's dependencies (bun install), or correct that import.
"pkg/src/gone" is not something its package provides. Check the version you have, or correct that import — installing dependencies will not help.
Nothing at "./src/gone". Create that file or correct the import — installing dependencies will not help.
```

**And the message names the file the way you wrote it.** On node the runtime hands back an already-resolved absolute path, so this line printed `/home/…` into guidance you are meant to act on — while every other refusal in the module deliberately drops our own frame.

Where a runtime supplies it, a failure also names the package the import was written in. That is the half that would have pointed at the real culprit in #480, where the message named the one dependency that was fine.
