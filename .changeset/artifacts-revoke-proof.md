---
"@pithy-sh/artifacts": patch
"@pithy-sh/auth": patch
"@pithy-sh/cloudflare": patch
---

The credential helper now takes an API key as documented, and the artifacts docs state, from a live test, what revoking every token reaches. Revoking one token through the control plane that the kit minted and that is already revoked or expired now answers `revoked: 0` rather than a 404.
