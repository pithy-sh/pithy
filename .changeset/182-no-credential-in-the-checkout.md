---
"@pithy-sh/cli": patch
"@pithy-sh/cloudflare": patch
---

No minted credential is written into the checkout, for any environment (#182).

Cloudflare's account credentials — `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `SECRETS_STORE_ID`,
`R2_CREDENTIALS` — are account-scoped, so they live in `<config>/cloudflare.json` at mode `0600` in the
`0700` config directory rather than in the project root's `.dev.vars`. `pithy init` records the pair at
the one moment you are holding both. The `process.env` overlay is unchanged, per key, so CI still passes
them as plain environment variables with no file at all.

`pithy token mint --store dev-vars` writes `<config>/<project>/tokens.json`, keyed by environment.
It wrote `.dev.vars` for dev and `.dev.vars.<env>` for everything else — so minting for production put a
live production Cloudflare token in the checkout. Gitignored is not sufficient: `npm pack` does not read
`.gitignore` when `files` is set (#145), and that path had its own `0664` permissions defect on record.

`pithy add secrets` resolves the account's Secrets Store and records `SECRETS_STORE_ID` — the one moment
in that key's life anything asks Cloudflare where the store is. Cloudflare permits one store per account,
so two is refused and named rather than guessed at, zero is explained, and a recorded id is never
overwritten (a mismatch is reported instead). Nothing here can fail the command: no credentials, no
network, and no store each cost a sentence.

`pithy doctor` names a `.dev.vars.<env>` still in the project, with its environment, and a Cloudflare
credential still in the root `.dev.vars`, with the file it belongs in. Reported, never moved.
