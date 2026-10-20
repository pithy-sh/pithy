---
"@pithy-sh/cli": minor
"@pithy-sh/cloudflare": minor
"@pithy-sh/core": minor
"@pithy-sh/i18n": minor
"@pithy-sh/media": minor
"@pithy-sh/secrets": minor
"@pithy-sh/storage": minor
---

Media now reports what was actually served — images delivered and minutes of video watched, per asset — read from Cloudflare's own analytics and joined to the assets you already have. A deployed application now holds one Cloudflare API token, `runtime`, minted with exactly what its capabilities call. **Breaking:** the secrets manager's own token and media's hand-made Images and Stream token are replaced by it; mint `runtime`, deploy, then revoke the old ones.

Security: No exposure is fixed, and one is widened. A deployed application holds one minted token in place of two or three, one of which an operator built by hand with whatever permissions they picked, and its R2 bundles no longer carry the bootstrap token. That is fewer credentials, not less privilege per Worker: `runtime` is the union of every composed capability's `runtimePermissions`, and every Worker it is bound into holds all of it. With secrets composed, the internet-facing app Worker and the media host now hold Secrets Store Write over the account's flat store, production's master key included; before, only the manager did. The owner accepted that design. `docs/TOKENS.md` states it. A feature's Workers bind no runtime token, so branch code never holds it.
