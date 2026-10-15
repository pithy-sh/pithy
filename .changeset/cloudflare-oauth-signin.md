---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/audit": minor
---

Sign in to Cloudflare in your browser and Pithy mints its own credentials — scoped to exactly the capabilities your project composes, bound to the directory you ran it in, and recorded against you rather than a token's name.

Security: The bootstrap token is over-privileged by construction: the delegation rule forces it to hold the union of every permission it will ever mint, so an adopter's first act is creating the most powerful credential they will ever hold — thirty-five permission groups in this project — by hand, from a documentation table, before they know which of it they need. A session scoped to the capabilities a project actually composes, minting narrow tokens from there, removes that credential from the setup path entirely.
