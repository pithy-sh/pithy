# GitHub sign-in

Adding GitHub to `@pithy-sh/auth`. Step by step.

## Why this part is manual

GitHub OAuth credentials are minted in GitHub Developer settings by a human with access to your GitHub account or organization. Pithy cannot create them for you. So this is a one-time manual setup. The rest of the flow is config.

## 1. Register an OAuth app

Open **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App** (for an org, use the organization's settings). One app per environment is cleanest, because each registers a single callback URL.

- **Application name**: whatever your users should see on the consent screen.
- **Homepage URL**: your app or site.
- **Authorization callback URL**: the exact redirect URI from the next section.

On create you get a **Client ID**. Generate a **Client Secret** on the same page. Where each goes is in [Where the credentials live](#where-the-credentials-live).

## 2. The exact redirect URI

Better Auth's OAuth `redirect_uri` is always:

```
<baseURL><basePath>/callback/github
```

With the default `basePath` of `/auth`, the path is `/auth/callback/github`. Register one URL per environment, each on that environment's `baseURL` host:

| Environment | Callback URL |
| --- | --- |
| dev | `http://localhost:8787/auth/callback/github` |
| staging | `https://staging.<your-domain>/auth/callback/github` |
| production | `https://<your-domain>/auth/callback/github` |

Use your actual local port for dev — `8787` is wrangler's default, not a guarantee. A GitHub OAuth app allows one callback URL, so register a separate app per environment.

### Every environment — and why feature-branch previews won't work

Each environment needs its **own** OAuth app, whose single **Authorization callback URL** is that environment's exact `baseURL` host. GitHub only accepts the one callback URL you registered on the app; anything else is rejected with *"The redirect_uri MUST match the registered callback URL for this application."*

This bites feature-branch previews. A branch deployed to a Cloudflare preview URL — an ephemeral `*.workers.dev` or preview alias, not your registered `staging.<your-domain>` — is not the callback URL on any of your apps, so GitHub sign-in there fails. You cannot exercise GitHub sign-in from a preview URL until an app is pointed at that exact URL.

To test GitHub on a branch, either register a throwaway OAuth app whose callback URL is that deployment's `<its-url>/auth/callback/github` (and point its credentials + `baseURL` at that deployment), or run the flow against your registered `staging` environment instead. Because a GitHub app allows only one callback URL, a per-branch app is the only way to test GitHub on an ephemeral URL.

Magic link and email OTP have no callback URL — they work on any URL, preview or not. Only the OAuth providers need a registered callback.

## 3. Scope

Pithy requests `user:email`. That is what lets the sign-in read your primary email and its verified status from GitHub's emails API. You do not configure scopes anywhere — Pithy sets this for you when GitHub is enabled.

## 4. Mobile

You do not register a deep-link URI with GitHub. GitHub only ever redirects to the Worker's `/auth/callback/github`. The mobile app passes its own deep link as the sign-in `callbackURL` (for example `myapp://auth/callback`); the Worker completes the exchange and redirects there. For that to be allowed, the scheme must be listed in `trustedOrigins` (prefix match):

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

## Where the credentials live

**Both credentials travel as one typed JSON secret.** The client id and client secret are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-github-credentials`:

```
pithy secrets create auth-github-credentials --json '{"clientId":"<your-client-id>","clientSecret":"<your-client-secret>"}'
```

Enable GitHub in config with `auth({ github: { enabled: true } })` — no credential values in the config.

## Account linking

One account per verified email. GitHub is **not** a trusted provider, so it links only on a verified email — a deliberate choice, because GitHub lets an account hold unverified addresses.

- **Verified email → automatic link.** A GitHub sign-in whose primary email is verified on GitHub, matching an existing user, links into that account. No second account.
- **Unverified email → verify first.** If your GitHub primary email is not verified on GitHub, Pithy will not silently link it and will not create a second account. Verify the email on GitHub, or sign in with a magic link to that address first, then connect GitHub. This closes the takeover hole where an unverified address could be linked to an account you do not own.
- **No seeding.** A GitHub sign-in whose email is unverified is refused rather than used to create a fresh account — so no one can seed a row at an address they have not proven they own.

## When the credential will not read

An enabled provider whose secret is missing, or whose stored value no longer matches its schema, costs
**that provider and nothing else**. Magic link, OTP, and every other provider keep signing people in.

A sign-in attempt with GitHub then answers `503` with the code `auth/provider_unavailable` and a
message naming github, rather than the `404 PROVIDER_NOT_FOUND` a provider nobody enabled gets — the two
are different facts and never share an answer. The attempt is recorded in the audit trail as
`auth/provider_unavailable`, which is where an operator learns a sign-in method is down. Fix it by
provisioning `auth-github-credentials` for that environment, or turn the provider off in config.

## Checklist

- [ ] GitHub OAuth app registered (one per environment).
- [ ] Authorization callback URL set to `<baseURL><basePath>/callback/github`, host matching each environment's `baseURL`.
- [ ] Client ID and a generated client secret in hand.
- [ ] Mobile deep-link scheme listed in `trustedOrigins` (no deep link in GitHub).
- [ ] `clientId` + `clientSecret` stored together via `pithy secrets create auth-github-credentials` (typed JSON); GitHub enabled in config with `github: { enabled: true }`.
- [ ] GitHub primary email verified on GitHub (or plan for the magic-link verify-to-link step).
