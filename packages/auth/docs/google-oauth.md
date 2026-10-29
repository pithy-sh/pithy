# Google sign-in

_The reader's version of this page is [pithy.sh/docs/build/auth-and-accounts/google-sign-in](https://pithy.sh/docs/build/auth-and-accounts/google-sign-in). This copy ships in the package because `packages/auth/src/capability.ts` sends an adopter to it by name._

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

A redirect sign-in starts in the system browser's sign-in sheet, not in the app. The app opens `GET /auth/sign-in/social/start?provider=google&callbackURL=…`, where `callbackURL` is its own link, `myapp://auth/callback` or a universal link, carrying the S256 challenge of a verifier only the app holds as `handoff_challenge`. The Worker completes the OAuth exchange and returns to that link with a one-time `?code=`, never a cookie. The app trades the code and the verifier at `POST /auth/handoff` for the session token. The link must be in `trustedOrigins`, the scheme by prefix and an https link by its origin:

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

[`apple-signin.md`](apple-signin.md) §6 has the handoff step by step, with the helpers from `@pithy-sh/auth/src/client/handoff`. `pithy ui add react-native` scaffolds a sign-in that does all of it.

**Native Google sign-in skips the redirect.** On a phone the scaffolded sign-in uses Google's SDK and posts the id token it gets to `POST /auth/sign-in/social`. The SDK asks for that token with the **web** client id as its audience, which is the one the Worker checks, so the credential stays the one web client above. Register an **iOS** and an **Android** OAuth client in Google Console too, which the SDK needs on each platform, then put the public ids in the app's `src/pithy-config.generated.ts`:

```ts
google: { webClientId: "<web-id>", iosClientId: "<ios-id>" },
```

`webClientId` null turns native Google sign-in off, and the app signs in with Google through the redirect instead. `iosClientId` is null on an Android-only app.

## Where the credentials live

**Both credentials travel as one typed JSON secret.** The client id and client secret are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-google-credentials`:

```
pithy secrets create auth-google-credentials --env <env>
```

At a terminal it asks for the value, masked. An agent or a script pipes the JSON document in on stdin instead. `--json` only shapes the output, and the value is never read from a flag:

```
printf '%s' '{"clientId":"<your-client-id>","clientSecret":"<your-client-secret>"}' | pithy secrets create auth-google-credentials --env <env>
```

The pair stays atomic: the client id never splits off into config. The package reads the whole credential from the secrets store at request time and wires it into the provider. Enable Google in config with `auth({ google: { enabled: true } })` — no credential values in the config.

## Account linking

A user who signed up with a magic link and later signs in with Google is linked automatically when the verified emails match. Google is configured as a **trusted provider**, and the local email is already verified — the magic link proved it — so the two accounts merge into one rather than colliding.

`requireLocalEmailVerified` stays on. That is the secure default: it blocks account takeover where an attacker pre-registers an unverified row for a victim's email and waits for the victim's Google sign-in to link into it. Leave it on.

## When the credential will not read

An enabled provider whose secret is missing, or whose stored value no longer matches its schema, costs **that provider and nothing else**. Magic link, OTP, and every other provider keep signing people in.

A sign-in attempt with Google then answers `503` with the code `auth/provider_unavailable` and a message naming google, rather than the `404 PROVIDER_NOT_FOUND` a provider nobody enabled gets — the two are different facts and never share an answer. The attempt is recorded in the audit trail as `auth/provider_unavailable`, which is where an operator learns a sign-in method is down. Fix it by provisioning `auth-google-credentials` for that environment, or turn the provider off in config.

## Checklist

- [ ] Google Cloud project created.
- [ ] OAuth consent screen: External, scopes `email` / `profile` / `openid`.
- [ ] Web OAuth client created; client ID and secret in hand.
- [ ] Redirect URI registered per environment, each as `<baseURL><basePath>/callback/google`.
- [ ] Redirect host matches each environment's `baseURL`.
- [ ] The app's scheme, and its universal-link origin when it has one, listed in `trustedOrigins` (no deep link in Google Console).
- [ ] Native Google sign-in: iOS and Android OAuth clients registered; `google.webClientId` and `google.iosClientId` set in the app's `src/pithy-config.generated.ts`.
- [ ] `clientId` + `clientSecret` stored together via `pithy secrets create auth-google-credentials` (typed JSON); Google enabled in config with `google: { enabled: true }`.
- [ ] `requireLocalEmailVerified` left on.
