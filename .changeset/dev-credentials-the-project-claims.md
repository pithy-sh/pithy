---
"@pithy-sh/cli": minor
---

`pithy dev` now authenticates every worker as the account your project claims.

It copied the parent environment wholesale and added only the port table, so `wrangler dev` used whatever `CLOUDFLARE_API_TOKEN` your shell last exported. On a machine with one account that is invisible. On a machine with two, a magic link left through a tenant that does not own the sending domain — five attempts, five failures, and a banner that had just said it was sending for real.

One module now builds the environment of every child that can reach Cloudflare, and `pithy deploy` and the capability host deploys go through it too. A `cloudflare.accountId` your credentials contradict is refused before a worker spawns rather than discovered by a send that fails. When your shell holds credentials for another account, the session says so once and uses the project's. Under `PITHY_OFFLINE` the children are handed no credentials at all.

`runWrangler` and `HostDeployOptions` now take the account as a required argument. Omitting it is a type error, because there is no safe default.

Security: a dev session no longer sends through, or a deploy ship to, whichever Cloudflare account the operator's shell last exported a token for.
