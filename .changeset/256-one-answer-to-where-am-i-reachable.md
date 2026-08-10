---
"@pithy-sh/core": minor
"@pithy-sh/cli": patch
---

`originFor(environment, domains)` — one answer to "where is this Worker reachable", so no capability asks an adopter to write an origin down.

Every capability that needs a public origin made the adopter type one, so a project with more than one environment wrote production's origin into staging's config. The first adopter's single Worker carried `https://app.pithy.sh` three times, in three capabilities, each wrong for staging in its own way: `auth.baseURL` mailed testers magic links **into production** and let the CSRF gate allow prod while refusing staging's own forms; `email.baseUrl` meant an unsubscribe from a staging test would have unsubscribed that person **in production**; the `payments` Stripe return URLs landed a staging payer **in production**, on an account that had bought nothing. Three capabilities, one mistake, three separate discoveries — because fixing it inside one capability does not stop the next capability asking the same question.

The two halves already existed and nothing composed them. `domainFor` and `baseUrlFor` are now composed once, in `@pithy-sh/core/src/naming/domains`:

```ts
const domains = { staging: { … }, prod: { … } };
const PUBLIC_ORIGIN = originFor(compositionEnvironment() ?? "dev", domains);
```

Named for the Worker rather than for whichever capability asked first. The adopter's own version was called `AUTH_BASE_URL`, which is part of why `email` and `payments` kept their literals for days — the constant read as auth's private business when it is the Worker's address.

**The fallback is the load-bearing part.** An environment absent from `domains` is one that is not published, so it resolves to `http://localhost` and to nothing else. That fails closed: a link that goes nowhere, useless rather than harmful. What it replaces fell back to production's origin, which is the only version of this that was actively dangerous. And a *deployed* environment can never keep that fallback, because `pithy deploy` refuses an environment whose config declares no origin — one rule in two halves rather than two rules that happen to agree.

`applyDomains` and `workerAddress` are routed through it, so `vars.BASE_URL` and the origins a Worker's capabilities were configured with are the same function's answer and cannot drift apart.

**`controlplane.issuer` deliberately does not derive**, and the docs say why. It is an identity, not an address: a connection stores the issuer it was created with and verification checks that stored value, so a per-environment issuer would make a connection minted in staging unverifiable in production. That may be the better isolation, but it is a decision about trust rather than about reachability, and a helper whose job is "where am I reachable" must not sweep it up.
