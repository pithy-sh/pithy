---
"@pithy-sh/cli": patch
---

`pithy worker add` no longer scaffolds through a symlink at `apps/<name>`.

The gate read the directory with `readdir`, which follows links, so a link pointing at an empty
directory anywhere on disk answered "empty" and the whole worker — plus a `.dev.vars` link — was
written outside the project, exit code 0. It now asks `lstat` about the path itself, and asks before
the directory is made, so a refusal creates nothing and the rollback has nothing to unlink.
