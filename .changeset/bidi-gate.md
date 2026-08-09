---
"@pithy-sh/cli": patch
"@pithy-sh/testers": patch
---

A file cannot carry a character review is unable to see.

#216 gated the one class of invisible character git itself notices: a byte that makes a file binary, so
its diff never renders. This is the other class — characters git renders perfectly happily, and a
reviewer still cannot see. **No committed file may hold a bidirectional control, or a C0 control other
than tab, newline and carriage return.**

**U+202E is why it is worth a gate.** A right-to-left override reorders how the text after it *displays*
without changing a byte of what the compiler reads — the Trojan Source technique (CVE-2021-42574).
Source that says one thing to a human and another to `tsc`. This repository is the right kind of target:
the kit is MIT and public, adopters run `pithy` against their own Cloudflare accounts, and the CLI mints
and reads credentials. An override landing in a template, a generated config line or a capability
manifest would be invisible in exactly the review that is supposed to catch it. The bidi set is the one
rustc's `text_direction_codepoint_in_literal` lint uses: U+202A–U+202E, U+2066–U+2069, U+200E, U+200F,
U+061C.

**The first run found ten, across five files, and only two were meant.** The override and the BEL in
`packages/testers/src/nudge/copy.test.ts` are deliberate input to the suite that proves hostile control
characters never reach a nudge body — the right thing to test, and the two occurrences #221 was filed
on. The other eight were a raw ESC nobody intended: seven in an esbuild error fixture copied between
three packages, and **one in shipped source.** `@pithy-sh/vite`'s ANSI-stripping regex held the byte
where two other copies of the same pattern spelled the escape — drift, in a filter, that no review could
have seen. #228 consolidated the three copies into `@pithy-sh/core` and took it with them.

That is the argument, no longer hypothetical: **the repository had no way to tell the deliberate two
from the accidental eight.** It is #216's argument about a NUL, which found two more the moment it
looked.

`copy.test.ts` keeps its coverage and builds both characters — `String.fromCharCode(0x202e)` — exactly
as #216's gate builds its NUL. The input is byte-identical; only the spelling changed.

**The scan reads the whole file, and the file set is git's index**, for #216's reasons. The first one
matters more here: git decides binary from the first 8000 bytes, so a gate that asks git turns itself
off as a file grows, and there is nothing about an override that confines it to a file's first page.

The exception list is empty and should stay that way: a file that needs one of these as input builds it.
Seven ESC bytes across three test fixtures are written down as debt instead, each with what it costs,
on a list that only shrinks and that fails if a path on it is quietly fixed or deleted.

Proved by planting: an override and a raw ESC in a committed file each fail the gate with the path and
the byte offset. Every refused character is a number in the gate, and constructed where one is needed —
writing a test about an override is the easiest way to put one in the test file, and unlike a NUL, one
that landed there would reorder the line a reviewer was reading it in.
