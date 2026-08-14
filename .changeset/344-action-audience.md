---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
"@pithy-sh/auth": patch
"@pithy-sh/storage": patch
---

Give `action` an audience, and enforce it where the boundary already is.

`PithyError` classified two of its three text fields. `message` was safe to expose, `detail` was stripped by the HTTP codec, and `action` was neither — so it went to the browser with everything else. Read the ones the kit ships and what it is becomes unmistakable: `Run \`pithy vector provision\``, `Bind a D1 database named DB in wrangler.jsonc`, `Set \`name\` in pithy.config.ts`, `Take the ${rail} credentials from <provider console> and set them with \`pithy secrets set\``. That is a sentence for somebody with the project checked out, and it was being handed to whoever tripped the error.

**`action` is operator-facing.** It now sits beside `detail` on `ErrorPayload` and is absent from `PublicErrorPayload`, so the wire shape has no such key to fill — the strip is a property of the schema, per code and without exception, for an adopter's own codes exactly as for the kit's. A remedy the *caller* needs has always had a field: `message`.

The operator's surfaces keep it. `renderTerminal` is unchanged, and the CLI's `--json` error line now encodes through `operatorError` rather than through the HTTP codec — both drop `detail`, but they drop it for different readers, and whoever ran the command is the person who can act on a wrangler binding.

Two remedies that a caller genuinely needed moved to `message`, where they are said in the open rather than carried by a field nobody had classified. Storage now answers a half-finished multipart upload with the route that resumes it, and the dev-login page — which registers only in a `dev` composition outside CI, so its browser is the developer's own — still names `pithy seed`.

Also: `<config>/cloudflare.json` promised that another tenant's key is "read and written back untouched" and silently deleted a `__proto__` one. `JSON.parse` gives it an own property, the parse skips it while rebuilding the object, and the write puts back what it was handed. The read-modify-write now refuses that document rather than quietly dropping the key from a file holding a live API token.
