---
"@pithy-sh/ui-react": patch
"@pithy-sh/cli": patch
---

The scaffolded SPA router matches path parameters.

`export const path = "/invitations/:token"` now routes, and the value arrives as a typed `params` prop: `ScreenProps<typeof path>` reads the names off the pattern, so `params.tokne` is a compile error and there is no second place to keep the names in step. Identifier-in-path is the ordinary shape for anything arriving by link — an invitation, a password reset, a shared record, an unsubscribe confirmation — and until now every adopter needing one either used a query string or forked a file the kit keeps changing underneath them. `pithy-sh/dashboard` shipped `/invitations?t=<token>`.

Four rules, each decided rather than emergent. A static segment beats a dynamic one at the leftmost segment where two patterns differ in kind, by comparing patterns rather than by whichever glob reached a file first — the previous table was a `Map` keyed on the literal path, so there was no order to get wrong, and adding one silently would have been the wrong way to answer it. Values are decoded once, in the router, after the split, so `%2F` is a slash inside a value; a malformed encoding does not match at all, rather than reaching a screen as raw text or as an empty string. A parameter captures at least one character, so `/invitations/` is not a token. And a pattern matches a path with the same segment count: no wildcards, no optional segments, no nesting.

`routes/pithy/otp.tsx` keeps its `?email=`, and now says why: that URL points at the code-entry screen, the address is a prefill rather than the resource, `/otp` with no email is a valid screen, and an address in a path is PII in every access log along the way.
