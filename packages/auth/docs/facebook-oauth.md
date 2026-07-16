# Facebook sign-in

Adding Facebook to `@pithy-sh/auth`. Step by step.

## Why this part is manual

Facebook Login credentials are minted in the Meta app dashboard by a human with access to your Meta developer account. Pithy cannot create them for you. So this is a one-time manual setup. The rest of the flow is config.

## 1. Create a Meta app

Open the [Meta app dashboard](https://developers.facebook.com/apps). Create an app, choose **Consumer** (or the type that fits), and add the **Facebook Login** product. One app covers all your environments; you register a redirect URI per environment below.

## 2. The exact redirect URI

Better Auth's OAuth `redirect_uri` is always:

```
<baseURL><basePath>/callback/facebook
```

With the default `basePath` of `/auth`, the path is `/auth/callback/facebook`. Under **Facebook Login → Settings → Valid OAuth Redirect URIs**, register one URI per environment, each on that environment's `baseURL` host:

| Environment | Redirect URI |
| --- | --- |
| dev | `http://localhost:8787/auth/callback/facebook` |
| staging | `https://staging.<your-domain>/auth/callback/facebook` |
| production | `https://<your-domain>/auth/callback/facebook` |

Use your actual local port for dev — `8787` is wrangler's default, not a guarantee. Facebook requires HTTPS for non-localhost redirect URIs.

## 3. Scope

Pithy requests the `email` scope. You do not configure scopes anywhere — Pithy sets it for you when Facebook is enabled.

## 4. Mobile

You do not register a deep-link URI with Facebook. Facebook only ever redirects to the Worker's `/auth/callback/facebook`. The mobile app passes its own deep link as the sign-in `callbackURL` (for example `myapp://auth/callback`); the Worker completes the exchange and redirects there. For that to be allowed, the scheme must be listed in `trustedOrigins` (prefix match):

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

## Where the credentials live

**Both credentials travel as one typed JSON secret.** The app id and app secret are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-facebook-credentials`:

```
pithy secrets create auth-facebook-credentials --json '{"clientId":"<your-app-id>","clientSecret":"<your-app-secret>"}'
```

Enable Facebook in config with `auth({ facebook: { enabled: true } })` — no credential values in the config.

## Account linking

One account per verified email. A Facebook sign-in whose email matches an existing user links into that account — no second account.

Pithy trusts Facebook's email as verified. Facebook confirms a user's email before it will hand it back, and Pithy validates the OAuth access token against your app before reading the profile — so the email is genuinely the signed-in Facebook user's, verified by Facebook. That is the same trust Google and Apple get. Better Auth's own OAuth response carries no `email_verified` claim (and the Graph API exposes no such field), so without this Facebook would treat every email as unverified; Pithy asserts verification for Facebook's own email only.

Facebook is **not** in `trustedProviders`. Trusting the returned email is not the same as trusting Facebook to link an *unverified* address — the assertion applies to the authenticated user's own Facebook email, which Facebook has verified.

## Checklist

- [ ] Meta app created with the Facebook Login product.
- [ ] Valid OAuth Redirect URI set to `<baseURL><basePath>/callback/facebook`, host matching each environment's `baseURL`.
- [ ] App ID and app secret in hand.
- [ ] Mobile deep-link scheme listed in `trustedOrigins` (no deep link in Facebook).
- [ ] `clientId` + `clientSecret` stored together via `pithy secrets create auth-facebook-credentials` (typed JSON); Facebook enabled in config with `facebook: { enabled: true }`.
