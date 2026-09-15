---
"@pithy-sh/cli": patch
---

A deploy creates nothing.

`pithy deploy --env staging` left two empty D1 databases on an account, seven seconds before the upload.
wrangler's `experimental-provision` is on by default for every deploy that is not a dry run: a binding it
cannot resolve by id, by the live script's settings, or by name is created. It covers eight binding kinds,
and for R2, queues and the namespace kinds the name is the id — so no reading of a config can tell a real
bucket from one wrangler is about to make.

Every `wrangler deploy` the CLI runs now carries `--experimental-provision=false`, for the Workers under
`apps/` and the kit's alike, and `runWrangler` refuses any argv without it before it spawns — so no
caller reaches wrangler around the rule, under whatever name it calls the seam by. wrangler rejects unknown arguments, so if it ever drops the switch a deploy fails loudly instead of
creating anything. `pithy deploy --kit` no longer creates a media or storage bucket nobody provisioned; that
Worker's row fails. The `deploy` scripts `pithy init` and `pithy worker add` write carry the switch too.

The readable half is the refusal before anything is built. It read `env.<name>` of the tracked file, which
missed three deploys: a bare one, which it never asked about; `--env dev`, which has no `env.dev`; and a
feature environment, whose ids live in the generated config. It now reads the stanza the deploy ships —
including the top level wrangler falls back to for a Worker with no `env.<name>` — and names each D1 and KV
binding with no id. A bare deploy and `--env dev` are sent to `--env staging` or `--env prod`, because dev
is local and has nothing to provision. `pithy env`'s line under a local stanza now says a bare deploy
refuses it.
