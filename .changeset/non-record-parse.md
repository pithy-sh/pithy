---
"@pithy-sh/cli": patch
---

A credential file that parsed to something other than a document is refused, not used as an empty base.

`readMintedTokens` answered `{}` for a `tokens.json` that parsed to `null`, a string, a number, a boolean or an array, and `writeMintedToken` used that same reader as its merge base. `readDevJson` did the same for `dev.json`, and `writeBootstrapVars` and `removeBootstrapVars` wrote over it. In both cases one malformed top-level value turned the next write into a replacement: `tokens.json` is keyed by environment, so every *other* environment's minted Cloudflare credential went with it, and `dev.json` has other tenants — the dev-login preference beside the bootstrap set. The run reported a clean write.

Neither existing defense could see it. `readOptionalFile` (#190) distinguishes absent from unreadable, which closes "the file would not open"; this read succeeded. The `ENOENT` gate names no errno here and discards no failure, so it sees nothing either. The loss happens one step later, when a writer treats an unexpected shape as an empty one.

Absent is still `{}`, and so is a file that will not **parse** — nothing can be made of it either way, and a half-typed `dev.json` must not stop `pithy dev`. A value that *parsed* is a claim about what is in the file, and it is now a refusal naming the path and the shape, with nothing written.

The check lives in `readOptionalFile.ts` rather than at the third, fourth and fifth call site. Three readers made this assumption independently — `pithy.worker.jsonc` (#204) and these two — which is this repository's count for a rule belonging at the thing being called. #204's own copy of the tag check is routed through it rather than left beside it, so there is one implementation and not two; each reader keeps its own sentence, exactly as each already keeps its own refusal for a file that would not open. It asks the value's own tag rather than `typeof`, because `typeof null === "object"` and **comment-json boxes a top-level scalar** so it has somewhere to hang the file's comments: `parse('"react"')` is a `String` object, not `null`, and `typeof` calls it an `"object"` too. A `null` check reads as the whole rule and is a quarter of it.

The two docstrings that claimed the writer was the one that refused now say what is true: for a non-record it never was.
