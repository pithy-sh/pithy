---
"@pithy-sh/cli": patch
---

Stop the test suite reaching the operator's machine and the operator's account.

Two defects, one shape. `bun run test` minted 36 real AES master keys into a maintainer's `~/.config/pithy` and wrote `SECRETS_STORE_ID` into their real `cloudflare.json`, because `addBootstrap.test.ts` passed no seam and nothing made the config directory fake (#200). Every unit suite that resolved a credential was talking to a live Cloudflare account, because `cloudflareEnv` overlays `process.env` per key — by design, so CI can pass credentials with no file — and anyone who has run `pithy deploy` has a token exported (#198). Both were fixed once, in one package, leaving the other twenty-one exposed.

Three layers, because the seam has to be impossible to forget rather than easy to remember.

A repo-root `vitest.setup.ts` gives every test file its own throwaway `PITHY_CONFIG_DIR`, and every project in every package loads it. `vitest.shared.ts` exports `NO_ACCOUNT` — every `CLOUDFLARE_ENV_KEYS` name blanked, derived from the list rather than copied from it, so a fifth key is covered by the commit that adds it — and every unit project states it. Integration projects deliberately do not: reaching a real account is the whole of what they are for.

**And `stateDir` refuses.** It is the single resolver behind dev secrets, dev preferences, `cloudflare.json` and the notifier state, so the invariant is checkable in one place: under vitest it answers from `PITHY_CONFIG_DIR` or from seams the caller passed, and never from `process.env` or `os.homedir()`. A safe default still lets a test opt back into the real directory by accident; a resolver that refuses cannot. A suite that means the real directory says so with `PITHY_ALLOW_REAL_CONFIG_DIR=1`, once, where a reviewer can see it. Nothing outside vitest is affected — a real `pithy` run never reaches this.

The gate is `packages/cli/src/ci/testIsolation.test.ts`. It **loads** each config and inspects the object vitest is handed rather than reading the source, because #198's first guard was a second `env:` key on one object literal, which JavaScript discards without a word — the file said covered and the run was not, for a fortnight. A guard that is present but inert now fails exactly like a missing one, as does one stated at the wrong nesting level: a root `env` reaches an inline project and a root `setupFiles` does not, so where a guard goes is measured rather than assumed.

Workers projects are exempt, structurally rather than by judgement: workerd does not inherit the host environment, so there is no ambient credential to blank and no real home directory to resolve.

Verified with a credential pair exported and no ambient `PITHY_CONFIG_DIR`: 2,384 CLI tests, plus the `cloudflare`, `secrets`, `core` and `audit` suites, and `~/.config/pithy` byte-identical before and after. Every socket the run opened went to `127.0.0.1`. Cleaning up a machine polluted by the old behaviour is documented in `CONTRIBUTING.md`.
