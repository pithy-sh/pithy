# @pithy-sh/turnstile

A Cloudflare Turnstile humanity check for Pithy. One piece of stackable middleware. No tables of its own. It answers one question — *is this a human?* — and stacks on top of any route's real verification strategy.

## What it is, and what it is not

Turnstile is **not** a verification strategy. A route's strategy answers *who is this?* (`bearer`, `session`, `signed-webhook`, `control-plane`, `public`). A humanity check answers *is this a human?* — a different question, so it can never be a route's identity gate. It is composable middleware that stacks on top: a `public` signup route that still requires a Turnstile token, a magic-link route that gates the credential entry, a lead form that runs the check silently.

This package ships the middleware and the config. It ships **no front-end component** — your app renders the widget with the public sitekey and posts the response token; the middleware verifies it.

## The middleware

```ts
import { turnstile } from "@pithy-sh/turnstile/src/http/middleware";

// Stack it on any route, on top of that route's real strategy.
app.use("/signup", turnstile());                       // public route, now bot-gated
app.use("/auth/magic-link", turnstile({ action: "login" }));
app.use("/lead", turnstile({ mode: "invisible" }));    // pick a widget when you run both
```

On each request it:

1. Resolves the widget secret through `@pithy-sh/secrets` — the secret `turnstile-secret-keys`, read via the one `secretsStore` reader like every Pithy secret (CLAUDE.md §secrets). The reader, not this package, decides where it lives (its registry entry says); the read is identical everywhere. The resolved value is `{ "visible": { "key": "…" }, "invisible": { "key": "…" } }`; with one widget it picks the only entry, with both `mode` selects. The app must have the `secrets` capability; the secret is `backend: "d1"`, so it resolves from the secrets store in every environment, local dev included.
2. Reads the response token — the `cf-turnstile-response` body field by default (form or JSON), or a header (`turnstile({ header: "x-turnstile-token" })`).
3. Verifies it against Cloudflare's `/siteverify`, sending the caller IP (`CF-Connecting-IP`). When `action` is set, it asserts the returned action matches and denies on mismatch (binding the token to the route it was solved for).
4. On success, lets the request continue to its real verification strategy. On failure, throws a `PithyError`.

It **fails closed.** A missing token, a failed verdict, an action mismatch, an unreachable siteverify, a malformed response — all deny. A bot gate never silently opens.

> Body note: in body-token mode the gate reads the request body (via Hono's `c.req`, which caches it, so your handler can read it again normally). If a downstream handler reads the **raw** stream (`c.req.raw.body`) instead, use header-token mode (`turnstile({ header })`) so the gate never touches the body.

### Errors

Every failure throws a `PithyError` subclass — importantly, **a request that fails the humanity check throws `TurnstileFailedError`** (`turnstile/failed`, 403), and that same error is thrown when the check *can't complete* (unreachable or malformed siteverify), because the gate fails closed. The three classes live in `@pithy-sh/turnstile/src/error/errors`:

| Class | Code | Status | When |
|-------|------|--------|------|
| `TurnstileMissingTokenError` | `turnstile/missing_token` | 400 | No token in the request where one was required. |
| `TurnstileFailedError` | `turnstile/failed` | 403 | The token did not pass siteverify, **or** the check could not complete (fail closed). |
| `TurnstileConfigError` | `turnstile/config` | 500 | The deployment is at fault: the secret is missing, malformed, has no entry for the route's widget, is one **Cloudflare does not recognize**, or is a **test key outside dev and staging** (a `secretsStore` read error is rewrapped to this). |

Register `pithyErrorHandler` on your Hono app (`app.onError(pithyErrorHandler)`) to map these to their HTTP responses; the `detail` is stripped from the wire body.

**A wrong secret is not a failed challenge.** siteverify answers HTTP 400 `invalid-input-secret` for a secret it has never issued, and every request is refused for as long as it is wired. That is `turnstile/config`, whose `action` line names `pithy turnstile provision` — a 403 would send whoever is debugging it to look at the user, which is the wrong person and an hour gone.

### Test keys and the `action` binding

Cloudflare's documented test secrets answer with **no `action` field at all**. `pithy turnstile provision` wires one into dev and staging, `@pithy-sh/auth` stacks its gate as `turnstile({ action: "login" })`, and so the binding compared `login` against nothing and refused every dev and staging sign-in (#374).

The binding is not relaxed. One narrow exception is, and it needs all three of:

1. Cloudflare's own `metadata.result_with_testing_key` flag on the answer — never a comparison against a list of key strings, so no real widget can reach it;
2. **no** action returned, so a token minted for a *different* action is refused exactly as before;
3. the Worker's stamped `ENVIRONMENT` being `dev` or `staging`.

The same flag runs the other way outside those two: a test key answering for a `prod` — or unstamped — Worker is a `turnstile/config`, because a secret that passes everybody on a production login page is a door, and it should be the loudest line in the log rather than a quiet 200.

**And it is why the login action is stated exactly once, as `TURNSTILE_LOGIN_ACTION`** (`src/config/config.ts`). The label is a contract with two ends — the widget solves for it, the route asserts it — and with the answer above carrying no action, dev and staging are structurally incapable of noticing them disagree. The first environment that can is production, where a mismatch refuses **every** sign-in with a 403 that truthfully blames the challenge. So the constant is the `protect` key, the value `@pithy-sh/auth` stacks its gate with, and the `action` in the client projection the front end renders (`turnstileConfig.action` — never a literal of the widget's own). #377.

## Two widgets per domain, max

An app may need both a **visible** widget (a login page should show the challenge — Cloudflare *managed* mode) and an **invisible** one (a lead form runs it silently). The logical maximum is one of each per domain; declare only what you use. The public **sitekey** for each lands in per-environment config so your front-end can render the widget.

```ts
// pithy.config.ts
turnstile({
  widgets: {
    visible: { sitekeys: { dev: "1x00000000000000000000AA", staging: "…", prod: "…" } },
  },
  protect: { login: "visible" },   // login (magic-link, OTP) → visible widget. Social/OAuth is never gated.
});
```

`@pithy-sh/auth` reads `protect` to stack `turnstile()` on its magic-link and OTP routes. **Social/OAuth login is never gated** — the provider runs its own bot defense and the redirect flow carries no token. This package never imports auth.

## Provisioning

`pithy add turnstile` installs the package and wires its config; the secrets capability must be present (`pithy add secrets` → `pithy secrets provision`) since the widget secret is stored and read through `@pithy-sh/secrets`. `pithy turnstile provision` then wires everything per environment:

- **dev and staging never create a real widget.** They wire Cloudflare's [documented test secret](https://developers.cloudflare.com/turnstile/troubleshooting/testing/) (always-pass) — dev into the local secrets store, staging into the **staging secrets store** (via the manager) — so both environments need zero CF round-trip and the positive/negative paths are trivially testable. Those two environments are also the only ones the gate will accept a test key from; see [Test keys and the `action` binding](#test-keys-and-the-action-binding).
- **Only `prod` provisions a real widget**, bound to the production domain in the configured mode. Its secret is written to the **`prod` secrets store**; the public sitekeys are written to the worker vars.

The widget is named `<project>-prod-turnstile-<mode>` — the one naming rule, see [docs/NAMING.md](../../docs/NAMING.md). `prod` sits in the environment slot because that is the only environment with a real widget; dev and staging wire the test keys and create nothing. The project segment is not decoration: a Turnstile widget is account-scoped and provisioning is reuse-or-create **by name**, so without it a second Pithy project in the same account adopts the first's widget and `deprovision` deletes it.

### One widget per domain

Provisioning refuses a production domain that another Turnstile widget on the account already covers, naming the widget that holds it. Cloudflare permits several widgets per domain; Pithy does not, because a second one is nearly always a forgotten first attempt and a front-end holding one sitekey cannot tell them apart. This project's own widgets never trip it — re-running `provision` is idempotent, as is running a visible and an invisible widget on one host.

If you genuinely need to sit alongside an existing widget — a hand-made one you are not ready to retire — pass `--allow-shared-domain`.

Because the secret is read through `secretsStore`, there is **no separate binding to materialize at deploy** — a production worker resolves it the same way it resolves every secret. (The `staging`/`prod` writes go through the deployed secrets manager, so `pithy secrets provision` must have run for those environments.)

## Setting the dev value

`pithy turnstile provision` writes it for you, and that is the shortest path.

To set it by hand, the secret is `turnstile-secret-keys` and it goes in the **dev secrets file**, not in
`.dev.vars`. `pithy doctor` prints the path. Its `backend` is `d1`, so it
is read from the secrets store in every environment — a `d1` secret written into `.dev.vars` is not read
at all, and the Worker says so: *"bound as a plain value, and a d1 secret is never read from a binding"*.

The value is a JSON object keyed by widget mode, so one or both widgets share it, and every value in that
file is a versioned envelope:

```jsonc
// one widget. 1x000…AA is Cloudflare's test secret: always passes.
// Swap it for 2x000…AA to exercise the deny path.
"turnstile-secret-keys": {
  "currentVersion": "1",
  "versions": { "1": { "visible": { "key": "1x0000000000000000000000000000000AA" } } }
}
```

With both widgets, add a second entry to the same object and pass `turnstile({ mode })` on each route:

```jsonc
"turnstile-secret-keys": {
  "currentVersion": "1",
  "versions": {
    "1": {
      "visible":   { "key": "1x0000000000000000000000000000000AA" },
      "invisible": { "key": "1x0000000000000000000000000000000AA" }
    }
  }
}
```

The **sitekeys are public** and are not secrets, so they stay in `.dev.vars` as ordinary bindings:

```sh
TURNSTILE_SITEKEY_VISIBLE=1x00000000000000000000AA
TURNSTILE_SITEKEY_INVISIBLE=1x00000000000000000000BB
```

Dev also needs the `secrets` capability in scope, and a `pithy migrate` — the store the reader reads is a
real D1 table. Running `pithy turnstile provision` / `deprovision` additionally needs the Cloudflare
bootstrap credentials (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`), the same ones `email` and
`secrets` use.

The package's own test suite reads none of these. Its Workers-runtime tests seed a real encrypted row
through the shared fixture in `@pithy-sh/secrets/src/test-utils`, which is the same path production takes.

## Testing against Turnstile

Cloudflare's dummy **secret** keys make siteverify deterministic with no widget:

| Secret | Verdict |
|--------|---------|
| `1x0000000000000000000000000000000AA` | always passes |
| `2x0000000000000000000000000000000AA` | always blocks |
| `3x0000000000000000000000000000000AA` | token already spent |

The package's Workers-runtime tests bind these and call the real siteverify endpoint, so the gate is exercised end to end without a real widget. `TURNSTILE_TEST_KEYS` (`@pithy-sh/turnstile/src/provision/testKeys`) exports the full set.
