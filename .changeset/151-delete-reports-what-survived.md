---
"@pithy-sh/cli": patch
---

Say what a failed delete left behind, and stop a write from widening a file it did not create.

A recursive delete that could not finish threw the raw `node:fs` errno and its stack through the `PithyError` contract — unparseable for a `--json` caller — and said nothing about the half-emptied tree it had already made. Reachable by accident: a directory the adopter chmod'd, a file another process holds open. `pithy worker remove board` now exits 1 with "Could not finish deleting apps/board. 8 paths are still there: …", and the errno stays in `detail`, where the codec strips it.

`writeFileAtomic` keeps the mode of a file it rewrites, which is how an adopter's deliberate 0400 survives a token write. It kept a *wider* one too, so a `.dev.vars` pre-created at 0644 handed a freshly minted `CLOUDFLARE_API_TOKEN` to every account on the machine, with nothing reported wrong. The mode a caller asks for is now a ceiling: tighter is adopted, wider is not. A caller that names no mode names no ceiling — those files hold no credential.

And the path walk stopped collapsing `..` above a component that exists and is not a directory. `package.json/../escaped.txt` is ENOTDIR to the kernel every time; the walk rewrote it into a path the caller never named and never checked, and the write landed there. A typo reaches it. The syscall judges the path it was given, and ENOTDIR now names the component in the way instead of telling the adopter to check that the file is writable.

Refs #151, #158.
