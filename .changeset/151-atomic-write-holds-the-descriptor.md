---
"@pithy-sh/cli": patch
---

An atomic write holds the descriptor it opened, and stops normalising a path it is about to hand to a
syscall.

The uid-ownership rule closed the escape. Three holes sat around it.

**The chmod was an arbitrary-chmod primitive.** The exclusive create closed the *write* half of the temp
path and left the *chmod* half open: `chmod(tmp, mode)` resolves the name a second time, so swapping the
temp file for a symlink after the open put the mode on the link's destination — any file the invoking user
owns, set to whatever the write asked for, which at 0666 is a disclosure. Reproduced: a 0600 private key
came back 0666. `fchmod` and the write now both go through the descriptor, so there is no name left to
redirect. The `rename` stays path-based because Node offers no descriptor-relative form of it, so the inode
at the name is checked against the inode the bytes went into first — a narrower race, not no race.

**The walk collapsed `..` past a component that does not exist.** The early return handed the remainder to
`join`, which normalises lexically: `missing/../apps/.dev.vars` came back as `apps/.dev.vars`, a path the
kernel would have refused, rewritten into one it walks — and the surviving components were then traversed
by the open with the ownership gate never asked about any of them. Reproduced against the real CLI: a live
`CLOUDFLARE_API_TOKEN` landed outside the project through an `apps` link nothing had checked. Past the
first missing component the walk resolves nothing and lets the syscall judge the path it was given.

**The adopted mode was not checked for ownership.** Keeping the target's mode is what respects an adopter's
deliberate 0640, and it is also an instruction read out of a file. Pre-creating `.dev.vars` at 0666 is one
line of work for whoever can write the project directory and cannot read the 0600 file in it — the position
every attack here is launched from — and the freshly minted secret landed world-readable with nothing
reported. A mode is adopted only from a file we own. Deliberately stricter than the link rule, which allows
root: a root-owned link sends a write somewhere root chose and root reads our files regardless, but a
root-owned 0666 gives the file to everybody else.

The tripwire that was meant to stop a sixth producer was got past three ways on the first try — `renameSync`,
a `.tmp` literal spelled any other way, and the same code one directory outside `packages/cli/src`. It
asked which idiom a file used, which is a guess at intent, and intent is what an evader controls. It now
asks which modules can reach a rename at all, across the whole repository. That is a fact about a module's
imports rather than a guess about its meaning, the answer is four files, and a fifth has to be written down
with a reason. Still a scan over source text, and said so in place: TypeScript 7 ships no parser API, and
Biome's `noRestrictedImports` with a per-path override is where the rule belongs when the chance comes.

Refs #151
