---
"@pithy-sh/cli": patch
---

Three corrections where one of two siblings had the rule and the other did not.

**the dev secrets file is narrowed like `.dev.vars`.** The mode was set by the write, and every caller filters out what is already in the file first — so a re-run of `pithy add` reaches the writer with nothing to add and the mode was never touched. A file created at the umask by an older pithy, an editor, or a `cp` stayed world-readable forever, holding the OAuth client secrets `.dev.vars` only carries a copy of. It is now narrowed on every path through the writer, including the one that writes nothing. Narrowing only: a deliberate `0400` survives, and a file that is not a regular file we own is left alone. One implementation, shared by both files, because the rule is about the contents and not the name.

**An unreadable `.dev.vars` no longer reads as an empty one in `pithy add`.** Two sites decided "is this secret already here?" with `readFile(...).catch(() => "")`, so an `EACCES` answered "no" and `add` minted a second value into the dev secrets file. The project then held two different values for one secret, one per file, with nothing to say which had signed what. Both sites now use the writer's own reader, where only `ENOENT` means absent.

**`pithy turnstile provision` says which Worker its value did not reach.** The third call site discarded the whole delivery report, so a Worker with a `.dev.vars` of its own got no sitekey and no secret while the command reported the test secret wired. It goes through the same renderer `pithy add` uses, to stderr, so `--json` output stays one line.
