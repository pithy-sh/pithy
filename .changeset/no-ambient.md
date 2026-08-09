---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": patch
---

Give the CLI a way to say no ambient credentials, and make `doctor` say where its credentials came from.

`PITHY_CONFIG_DIR` relocates the config *file*. It never touched the `process.env` overlay, and that overlay is right — CI supplies `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as environment variables and has no file at all. The consequence was that redirecting the config directory looked like isolation and was not: `pithy doctor` in an empty scratch directory reached a real Cloudflare account off a token the shell had exported hours earlier, and reported `reachable (token active)` about an account nobody in that session had named. Twice.

`PITHY_OFFLINE=1` is the word that stops it, and `pithy doctor --offline` is the same word at a prompt. Pithy stops reading the credential pair out of the environment, and `doctor` reports **not checked** rather than probing. It never fails the exit — nothing was established — and the version lines say `skipped` rather than blaming a registry nobody asked. An adopter on a plane gets a full report and a green exit.

It is a variable rather than a flag on every command because it bites in the one function all of them resolve credentials through, and because a variable is inherited by a spawned `pithy`, `wrangler`, or test runner. It gates the environment and not the file: a credential you wrote down is not one you forgot you exported. So `PITHY_CONFIG_DIR=/tmp/scratch PITHY_OFFLINE=1` resolves nothing at all, which is the guarantee people already believed the first variable gave them.

`PITHY_CONFIG_DIR` was not made to imply it. That conflates *read config from here* with *do not use the environment*, and CI legitimately means the first without the second.

Separately, and for when a call is made anyway: the `Cloudflare:` line now names **where the credentials came from**, not only which file was resolved. In CI those are different answers — the resolved path holds nothing and the environment does the authenticating — and `; from ~/.config/pithy/cloudflare.json` was the report naming a file it had not read. `credentialSource` in `--json`, beside a new `offline`.

The overlay itself is unchanged, and CI with environment credentials and no file is tested to stay exactly as it was.
