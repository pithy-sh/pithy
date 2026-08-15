---
"@pithy-sh/cli": minor
---

A feature teardown that failed partway says what it destroyed.

`deprovisionFeature` deletes real Cloudflare infrastructure one resource at a time, with no transaction across them, and the list of what went is the whole product of `pithy feature destroy`. A throw from the fourth delete took the record of the first three with it: the databases were gone and nothing anywhere said so, on a command that runs headlessly in CI.

The report is carried on the failure now, through `partialWriteReport` — the mechanism #324 built for exactly this and which lives next door. `deletedBeforeFailure(error)` reads back every resource deleted, by `kind`, `name` and `id`. `destroyFeature` moves it onto its own report and `pithy feature destroy` prints it before rethrowing, with `"interrupted": true` under `--json`.

**The manifest is now removed only on a clean pass.** It is the record of what is left to delete, and a teardown that failed partway is precisely when a re-run needs it. The local half — freeing the port block, pruning the worktree — deliberately does not run either: the worktree is where the re-run happens from.

**Nothing from the throw travels.** The three recorded facts are the ones an operator finishes the teardown by hand with.
