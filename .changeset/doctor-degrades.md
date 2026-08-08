---
"@pithy-sh/cli": patch
---

One unreadable rc file no longer costs the whole `pithy doctor` report.

`doctor` read the shell rc file with no catch, so a `~/.bashrc` with the wrong mode, a dangling symlink, or an `EIO` threw out of `buildDoctorReport` and took **everything** with it: Cloudflare reachability, the secrets paths, project health, dev secrets. The least important line in the report cost every other line. #203 made that failure legible — a `PithyError` naming the file rather than a bare `EACCES` — and it was still a failure.

Catching it to `false` is not the fix, which is why #203 stopped where it did. `Alias: not installed` about a file nothing could read is a lie, and the adopter's next move on reading it is `pithy alias`, which fails on the same file. So the field is tri-state, and the third state names the file:

```
Alias: unknown — can't read ~/.bashrc. Fix that first; `pithy alias` reads the same file.
```

It keeps the report verbose, because "I could not check" is worth the ink, and it never fails the exit — toolchain state does not. In `--json`, `alias` is an object rather than a string: `state` (`installed`, `not-installed`, `unknown`), `rcPath`, and `reason` — the refusal's own sentence, and never a byte of the file's contents, since an rc file is where a developer keeps `export GITHUB_TOKEN=…`.

The rule this restores is written in `doctor`'s own source, and the rc read was the one place it was not held: **a diagnostic has to work in the environment it diagnoses.** Every other read in the command already degrades. The one remaining exposure was not a read at all — `doctor` *writes* its notifier cache, and a config directory that will not take a write is exactly the machine somebody runs `doctor` on. That write is bookkeeping for the next run and is now discarded on failure like everything else. Every other file the report touches was made unreadable in turn against a real scaffold, and the report still renders.
