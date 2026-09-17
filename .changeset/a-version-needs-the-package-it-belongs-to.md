---
"@pithy-sh/core": patch
"@pithy-sh/audit": patch
"@pithy-sh/auth": patch
"@pithy-sh/email": patch
"@pithy-sh/i18n": patch
"@pithy-sh/leaderboard": patch
"@pithy-sh/ledger": patch
"@pithy-sh/matchmaking": patch
"@pithy-sh/media": patch
"@pithy-sh/multiplayer": patch
"@pithy-sh/organization": patch
"@pithy-sh/payments": patch
"@pithy-sh/rating": patch
"@pithy-sh/secrets": patch
"@pithy-sh/storage": patch
"@pithy-sh/support": patch
"@pithy-sh/testers": patch
"@pithy-sh/turnstile": patch
"@pithy-sh/vector": patch
---

Every capability reports the package that supplies it, beside the version it already reported. `GET /control-plane/manifest` carried a version per capability and no package name, and a version is only actionable joined against a release feed keyed by package — so a client had to derive one from the capability's name. `@pithy-sh/<name>` is right for most capabilities and wrong for the one that matters: the seam is named `controlplane` and ships inside `@pithy-sh/core`, so the guess asked about a package that has never been published, the join came back empty, and empty is indistinguishable from *up to date* for the most frequently released package in the feed. Each capability now sets `package` from its own generated `PACKAGE_NAME`, stamped from its own `package.json` — never derived from `name` by the framework, because a capability name and a package name are different kinds of thing and one package may ship more than one capability. `package` and `version` are null together, which is the adopter's own `app` capability: a name, no package, no version. The field is optional on the wire, so a manifest produced by a Worker deployed before this parses whole and reads as null, and a client falls back to whatever it guessed before rather than losing every pane over one key. A repo-wide gate enumerates the capability packages from the source tree and fails when one declares a package that is not its own `package.json` name, or reads the constant from a sibling.
