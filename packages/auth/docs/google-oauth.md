# Google sign-in

Adding Google to `@pithy-sh/auth`. Step by step.

## Why this part is manual

Google OAuth credentials are minted in Google Cloud Console by a human with access to your Google account. Pithy cannot create them for you — there is no API to provision an OAuth client on your behalf. So this is a one-time manual setup. The rest of the flow is config.

## 1. Create a Google Cloud project

Open the [Google Cloud Console](https://console.cloud.google.com). Create a project, or pick an existing one. One project covers all your environments; you register a separate redirect URI per environment below.

## 2. Configure the OAuth consent screen

Under **APIs & Services** → **OAuth consent screen**:

- User type: **External**.
- Add the scopes `email`, `profile`, and `openid`. Nothing more — Pithy only needs identity.
- Fill the app name, support email, and developer contact.

While the app is in **Testing**, only test users you list can sign in. Publish it when you are ready for real users.

## 3. Create OAuth client credentials

Under **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID** → **Web application**.

Name it, then register the authorized redirect URIs from the next section. On create you get a **client ID** and a **client secret**. Where each goes is in [Where the credentials live](#where-the-credentials-live).

## 4. The exact redirect URI

Better Auth's OAuth `redirect_uri` is always:

```
<baseURL><basePath>/callback/google
```

With the default `basePath` of `/auth`, the path is `/auth/callback/google`. Register one URI per environment, each on that environment's `baseURL` host:

| Environment | Redirect URI |
| --- | --- |
| dev | `http://localhost:8787/auth/callback/google` |
| staging | `https://staging.<your-domain>/auth/callback/google` |
| production | `https://<your-domain>/auth/callback/google` |

Use your actual local port for dev — `8787` is wrangler's default, not a guarantee.

Two rules. The path is `basePath` + `/callback/google` — if you set a custom `basePath`, the path changes to match it. The host must equal each environment's `baseURL` exactly. A mismatch is the most common cause of `redirect_uri_mismatch`.

### Every environment — and why feature-branch previews won't work

Each environment your app runs in needs its **own** redirect URI registered here, on that environment's exact `baseURL` host. Google only accepts a URL you have registered; anything else is a `redirect_uri_mismatch`.

This is the gotcha with feature-branch previews. A branch deployed to a Cloudflare preview URL — an ephemeral `*.workers.dev` or preview alias, not your registered `staging.<your-domain>` — is a host Google has never seen, so Google sign-in there fails. You cannot exercise Google sign-in from a preview URL until that exact URL is registered.

To test Google on a branch, either register that deployment's own `<its-url>/auth/callback/google` as an extra authorized redirect URI **and** point that deployment's `baseURL` at the same host, or run the flow against `dev` (localhost) or your registered `staging` environment instead.

Magic link and email OTP have no redirect URI — they work on any URL, preview or not. Only the OAuth providers need a registered callback.

## 5. Mobile

You do **not** register a custom-scheme or deep-link URI in Google Console. Google only ever redirects to the Worker's `/auth/callback/google`. The Worker, not Google, is what hands control back to the app.

The mobile app passes its own deep link as the sign-in `callbackURL` — for example `myapp://auth/callback`. The Worker completes the OAuth exchange, then redirects to that deep link. For this to be allowed, the scheme must be listed in `trustedOrigins` (prefix match):

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

For native iOS or Android using the Google SDK's id-token flow (rather than the web redirect), register the platform-native **iOS** and **Android** OAuth client IDs in Google Console too, and pass all client IDs as an array:

```ts
auth({
  google: { clientId: ["<web-id>", "<ios-id>", "<android-id>"] },
});
```

## Where the credentials live

**Both credentials travel as one typed JSON secret.** The client id and client secret are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-google-credentials`:

```
pithy secrets create auth-google-credentials --json '{"clientId":"<your-client-id>","clientSecret":"<your-client-secret>"}'
```

The pair stays atomic: the client id never splits off into config. The package reads the whole credential from the secrets store at request time and wires it into the provider. Enable Google in config with `auth({ google: { enabled: true } })` — no credential values in the config.

## Account linking

A user who signed up with a magic link and later signs in with Google is linked automatically when the verified emails match. Google is configured as a **trusted provider**, and the local email is already verified — the magic link proved it — so the two accounts merge into one rather than colliding.

`requireLocalEmailVerified` stays on. That is the secure default: it blocks account takeover where an attacker pre-registers an unverified row for a victim's email and waits for the victim's Google sign-in to link into it. Leave it on.

## Checklist

- [ ] Google Cloud project created.
- [ ] OAuth consent screen: External, scopes `email` / `profile` / `openid`.
- [ ] Web OAuth client created; client ID and secret in hand.
- [ ] Redirect URI registered per environment, each as `<baseURL><basePath>/callback/google`.
- [ ] Redirect host matches each environment's `baseURL`.
- [ ] Mobile deep-link scheme listed in `trustedOrigins` (no deep link in Google Console).
- [ ] Native id-token flow: iOS/Android client IDs registered, all IDs passed as an array.
- [ ] `clientId` + `clientSecret` stored together via `pithy secrets create auth-google-credentials` (typed JSON); Google enabled in config with `google: { enabled: true }`.
- [ ] `requireLocalEmailVerified` left on.
