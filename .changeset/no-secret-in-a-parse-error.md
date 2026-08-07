---
"@pithy-sh/cli": patch
---

A malformed `.dev.secrets.jsonc` no longer prints its own contents.

`comment-json` embeds the entire source in its `SyntaxError.message`. The write path re-parsed with a
bare `parse` and no catch, so one missing brace put every value in the file on the terminal. Every parse
in the module now raises the loader's sanitized error — a path, a line, a column, and nothing else.
