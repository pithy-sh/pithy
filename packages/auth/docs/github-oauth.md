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

## Checklist

- [ ] GitHub OAuth app registered (one per environment).
- [ ] Authorization callback URL set to `<baseURL><basePath>/callback/github`, host matching each environment's `baseURL`.
- [ ] Client ID and a generated client secret in hand.
- [ ] Mobile deep-link scheme listed in `trustedOrigins` (no deep link in GitHub).
- [ ] `clientId` + `clientSecret` stored together via `pithy secrets create auth-github-credentials` (typed JSON); GitHub enabled in config with `github: { enabled: true }`.
- [ ] GitHub primary email verified on GitHub (or plan for the magic-link verify-to-link step).
