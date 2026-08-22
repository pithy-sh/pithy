---
"@pithy-sh/core": patch
---

`blankComments` strips comments from TypeScript source without mistaking a string for one.

A pattern over comments has no notion of a string, so a string is where a comment is forged. A `//` inside a URL opens a line comment and blanks the rest of the line. An unbalanced `/*` inside a `**/*` glob opens a block comment that runs to the next `*/` anywhere later in the file. Both were measured: planted into this package's own shipped source, the URL shape hid a bare `D1Database` from the gate that exists to find it, and the gate passed.

It is a character walk instead. Comments are blanked rather than deleted, so every line number and every offset survives and a caller may split, index or slice against the original. Strings are stepped over rather than blanked, which keeps a real read inside a template literal visible. A regex literal is stepped over too, told from division by the last significant character, and an unterminated string or regex stops at the newline so a wrong guess costs one line rather than the rest of the file.

It lives here because this is the package every caller may import. `@pithy-sh/core` must not depend on `@pithy-sh/cli`, and `worker-safety.test.ts` needs the walk — so the CLI could not hold it. The module imports nothing and touches no Node builtin, which is the property that same gate enforces.
