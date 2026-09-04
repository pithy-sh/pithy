---
"@pithy-sh/cloudflare": patch
"@pithy-sh/email": patch
---

The published floors are audited at the floor, and four of them were handing adopters a critical.

`bun audit` reads the lockfile — the versions *we* resolved. An adopter has neither our lockfile nor
our resolution and lands wherever their own resolver puts them, which for a caret range can be the
bottom of it. #397 set the floors on the strength of a lockfile audit, which answers a different
question. Pin every published caret at its own minimum, install that, and audit it, and the answer
before this change was **36 vulnerabilities — 2 critical, 16 high, 14 moderate, 4 low.**

**`handlebars` moves from `^4.7.8` to `^4.7.9`** in `@pithy-sh/email`, where it is a runtime
dependency. The advisory range is `>=4.0.0 <=4.7.8` and the floor sat exactly on its top: JavaScript
injection via AST type confusion, critical, plus four highs. `4.7.9` is the only fixed release.

**`js-base64` moves from `^3.7.0` to `^3.9.2`** in `@pithy-sh/cloudflare`. `js-base64@3.7.0` declares
`mocha` as a *runtime* dependency — an upstream packaging fault, fixed later — so the old floor pulled
`nanoid`, `minimatch`, `js-yaml`, `serialize-javascript` and `diff` into an adopter's tree with
fourteen advisories between them. `3.9.2` has no dependencies at all.

**`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` move from `^3.700.0` to `^3.1111.0`**, for
`fast-xml-parser <5.7.0` — one critical, two high — plus `@smithy/config-resolver` and `uuid`.

At the corrected floors the same check reports **5**: the `undici` set reached through `miniflare`,
which no floor of ours can move and which is in no deployed Worker.

**No version we install moved.** Every one of the four was already resolving above its own floor, so
this is a declaration change with no behavior change — which is exactly why a lockfile audit could
not see it. A floor is a security decision, so it states the lowest version that is *safe*, not the
lowest that *works*. `docs/STACK.md` §17 carries the check to re-run.
