---
"@pithy-sh/cli": minor
"@pithy-sh/turnstile": minor
---

`pithy turnstile provision` writes the sitekeys where the front end reads them.

A sitekey is a build input. The `pithy()` Vite plugin inlines the turnstile capability's client projection, and the projection reads `widgets.<mode>.sitekeys.<environment>` out of `pithy.config.ts`. Provisioning wrote `TURNSTILE_SITEKEY_<MODE>` into Worker vars and `.dev.vars` instead, where nothing read them. The config stayed blank, no widget rendered, and sign-in failed closed on staging and prod behind a successful provision.

Provisioning now writes every environment's sitekey into the target Worker's `turnstile({ ... })` registration: Cloudflare's test sitekey for dev and staging, the real widget's for prod. String literals only, in place. An expression that already resolves to the value is left alone. The config is loaded back through the real loader, and a value the capability does not then resolve restores the file and refuses. Its output says a redeploy is required, because the build inlines the value.

- **Stranded vars are removed.** Provision and deprovision strip any `TURNSTILE_SITEKEY_*` from the Worker's `wrangler.jsonc` and from `dev.json`. `pithy doctor` names any still in a Worker's `wrangler.jsonc`, in `dev.json`, or in the project root's `.dev.vars`, where #53's writer put them.
- **`pithy doctor` has a `Turnstile:` block.** It names each environment whose build renders no widget, with the remedy when there is one. It reports and never fails the exit. `--json` carries it as `turnstileSitekeys`.
- **Environments beyond dev, staging and prod are named.** A declared `live` and every feature build have no sitekey slot, so their builds render no widget. `provision` lists them in `environmentsWithoutSitekeys` instead of leaving the bundle to say `enabled: false` in silence.
- **One Worker for the read and the write.** The widget modes came from the first Worker composing turnstile while the sitekeys went to `--worker`. Both now come from the `--worker` target.
- **`pithy add turnstile` scaffolds a visible widget**, so provisioning runs without a hand edit. It used to render `turnstile()`, whose default gates login with a widget nobody declared.

`--json` for `turnstile provision` adds `sitekeys`, `strandedVarsRemoved`, `configFile`, `redeployRequired` and `environmentsWithoutSitekeys`.

`@pithy-sh/turnstile`'s `TurnstileProvisioner` seam changes shape: `writeDev` takes the secret alone, `writeManagedSitekeys` is replaced by `writeSitekeys` and `removeStrandedSitekeyVars`, and the deprovisioner's `clearManagedSitekeys` by `clearProductionSitekeys` and `removeStrandedSitekeyVars`. `sitekeyVarName` is gone; `isStrandedSitekeyVar` finds what it named.
