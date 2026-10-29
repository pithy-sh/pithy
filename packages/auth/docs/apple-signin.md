# Apple sign-in

_The reader's version of this page is [pithy.sh/docs/build/auth-and-accounts/apple-sign-in](https://pithy.sh/docs/build/auth-and-accounts/apple-sign-in). This copy ships in the package because `packages/auth/src/capability.ts` sends an adopter to it by name._

Adding Sign in with Apple to `@pithy-sh/auth`. Step by step.

Apple is first-class here because Pithy is mobile-first. Apple's App Store guidelines require you to offer Sign in with Apple once you offer another third-party sign-in like Google. If your app ships Google, it ships Apple too.

## Why this part is manual

Sign in with Apple credentials are created in the [Apple Developer portal](https://developer.apple.com) by a human with access to your Apple Developer account. Pithy cannot create them for you — there is no API to provision an App ID, a Services ID, or a signing key on your behalf. So this is a one-time manual setup. The rest of the flow is config.

There is one extra wrinkle Google does not have: Apple's client secret is not a static string. It is a JWT you sign yourself, and it expires. More on that in [Generate the client secret](#4-generate-the-client-secret).

## 1. Register an App ID

Under **Certificates, Identifiers & Profiles** → **Identifiers** → **App IDs**, register an App ID for your iOS app. Enable the **Sign in with Apple** capability on it.

The App ID's bundle id — for example `com.example.myapp` — is the `appBundleIdentifier`. The native iOS flow uses it as the id-token audience. Note it down.

## 2. Create a Services ID

Under **Identifiers** → **Services IDs**, create a Services ID. This is the OAuth `clientId` for the web and redirect sign-in flow — distinct from the App ID above.

Enable **Sign in with Apple** on the Services ID and configure it. Add your web domain and the return URL from the next section. Apple requires the domain be verified.

## 3. Create a Sign in with Apple key

Under **Keys**, create a new key with **Sign in with Apple** enabled. On create you can download the private key once as a `.p8` file — download it and keep it safe. You cannot download it again.

Note two values:

- The **Key ID** shown on the key.
- Your **Team ID** — the ten-character id in your Apple Developer account membership.

You now hold three things: the `.p8` private key, its Key ID, and your Team ID.

## 4. Generate the client secret

Apple's client secret is not a string you copy. It is an **ES256 JWT** you sign with the `.p8` private key. The claims:

| Claim | Value |
| --- | --- |
| `iss` | your Team ID |
| `sub` | your Services ID (the `clientId`) |
| `aud` | `https://appleid.apple.com` |
| `exp` | an expiry **at most six months** out |

That signed JWT **is** the `clientSecret`. Sign it with the `.p8`, the Key ID in the JWT header (`kid`), and `alg: ES256`.

Because `exp` caps at six months, the secret expires. Regenerate and rotate it on a schedule — the secret is stored as **rotatable** so a fresh JWT can replace the old one without a config change. See [Where the credentials live](#where-the-credentials-live).

## 5. The exact return URL

Better Auth's Apple callback is always:

```
<baseURL><basePath>/callback/apple
```

With the default `basePath` of `/auth`, the path is `/auth/callback/apple`. Register one return URL per environment in the Services ID, each on that environment's `baseURL` host:

| Environment | Return URL |
| --- | --- |
| dev | `http://localhost:8787/auth/callback/apple` |
| staging | `https://staging.<your-domain>/auth/callback/apple` |
| production | `https://<your-domain>/auth/callback/apple` |

Apple requires the domain be verified and uses https. It does not accept plain http, so localhost generally will not work as a return URL — dev typically uses the native iOS flow or a tunneled https domain instead.

Apple sends the callback as a **POST** (`form_post`), not a redirect GET. Better Auth handles that. You do not need to change anything for it.

### Every environment — and why feature-branch previews won't work

Each environment needs its **own** return URL registered on the Services ID, on that environment's exact `baseURL` host — and Apple additionally requires that host's domain be **verified**, over https. Apple only returns to a URL you have registered.

Apple is the strictest here for feature branches. A branch deployed to a Cloudflare preview URL — an ephemeral `*.workers.dev` or preview alias, not your registered `staging.<your-domain>` — is neither registered nor domain-verified, so web Apple sign-in there simply cannot complete. Registering and verifying a throwaway preview domain per branch is impractical, so do not expect to test the web Apple flow from a preview URL.

To exercise Apple on a branch, use the **native iOS flow** (which sends an id token straight to the Worker and needs no return URL), or run against your registered `staging`/`production` environment.

Magic link and email OTP have no return URL — they work on any URL, preview or not. Only the OAuth providers need a registered callback.

## 6. Mobile

Native iOS uses Apple's own Sign in with Apple flow, not the web redirect. The app asks Apple for an identity token with `expo-apple-authentication` and posts it to the Worker. The `appBundleIdentifier` is the audience that token is validated against, which is why it is part of the credential.

The route is Better Auth's social sign-in, with the token in the body instead of a redirect:

```http
POST /auth/sign-in/social
Content-Type: application/json

{ "provider": "apple", "idToken": { "token": "<identity token>", "nonce": "<raw nonce>" } }
```

`nonce` is the raw value the app generated. Hand Apple its SHA-256 and send the raw one here; the Worker accepts either form. A token older than an hour is refused. The answer is `{ "token": "<session token>", "user": { … } }`, and `token` is the bearer credential: hand it to `session.adopt` from `@pithy-sh/auth/src/client/bearer`, which stores it in the Keychain and rotates it before it expires. `pithy ui add react-native` scaffolds the screen that does all of this. A refusal arrives in Better Auth's own shape, for example `{ "code": "INVALID_TOKEN" }` when the audience does not match `appBundleIdentifier`.

You do **not** register a deep-link or custom-scheme URL in the Apple portal. Apple only ever returns to the Services ID's return URL or, for native, hands the identity token straight to the app.

A provider without a native token flow signs in through the redirect instead, and comes back to the app on its own link. Use an https universal link (iOS) or app link (Android) when you can: the system opens it only in the app that proves it owns the domain, through `apple-app-site-association` or `assetlinks.json`. A custom scheme such as `myapp://` works too, but any installed app can claim one. Either must be in `trustedOrigins`, the https link by its origin and the scheme by prefix, or the Worker refuses the `callbackURL`:

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

Set the app's `universalLinkOrigin` and that origin must be in `trustedOrigins` too, beside the scheme. The scaffolded sign-in then returns on the https link, and an in-app auth session closes on an https callback only on iOS 17.4 or later. To support an older iOS, leave `universalLinkOrigin` unset and return on the custom scheme.

A cookie set on that redirect would land in the system browser, which the app never reads, so the Worker hands the session over with a one-time code instead:

1. Before the sign-in starts, the app makes a verifier with `createHandoffVerifier` from `@pithy-sh/auth/src/client/handoff`, passing `expo-crypto`'s `getRandomBytes` and `digest`. It keeps the verifier in memory.
2. It opens `nativeSignInStartURL({ origin, provider, callbackURL })` with `WebBrowser.openAuthSessionAsync`, where `callbackURL` is `handoffCallbackURL("https://app.example.com/auth/callback", challenge)`, or the custom-scheme link: the app's link with the verifier's S256 challenge on it as `handoff_challenge`. That is `GET /auth/sign-in/social/start`, which starts the sign-in inside the sign-in sheet and sends it on to the provider. Never post `/auth/sign-in/social` from the app for a redirect: Better Auth checks a signed `state` cookie at the provider's callback, and only the sheet's own jar can carry it there. The route refuses a navigation another page started (`Sec-Fetch-Site` other than `none`), so open it from the app, never from a link.
3. The sign-in returns to `https://app.example.com/auth/callback?code=<code>`. `handoffCode(link)` reads it, on any React Native runtime.
4. Within 60 seconds, the app calls `exchangeHandoff({ code, verifier }, session.options)`, which posts both to `POST /auth/handoff`. The answer is `{ "token", "expiresAt" }`. Hand `token` to `session.adopt`.

The code is good once. A spent, expired or unknown code, or a wrong verifier, gets `auth/handoff_invalid`, and any attempt spends the code: sign in again. So does a verifier outside RFC 7636's shape, 43 to 128 characters from `A-Z a-z 0-9 - . _ ~`; `createHandoffVerifier` always makes one inside it. Another app that claims the same scheme and catches the link has the code but not the verifier, so it has nothing to trade. A custom-scheme link with no challenge gets `?error=handoff_challenge_required` and no code.

A magic link on native needs a universal link. Whoever asks for a magic link chooses its challenge, and somebody else opens it, so an app that claims your custom scheme could ask for a link to your user's address and catch the code it hands back. The Worker hands a magic link off only to an https link in `trustedOrigins`; one to a custom scheme gets `?error=handoff_scheme_refused`, and no session is kept. Without a universal link, sign in by email with a one-time code instead.

The challenge is what asks for a code. An `https` callback that carries one is handed off like a custom scheme. An `https` callback without one is a web page to the Worker, so it gets a cookie, as a browser would, and no code.

The device id goes to the auth routes alone. It is listed to operators and recorded in the audit trail, so no other capability takes it as proof of anything. Consent knows a signed-out phone by a visitor id of its own, which the scaffolded app mints and keeps in the secure store.

## Where the credentials live

**All three values travel as one typed JSON secret.** The Services ID, the signed JWT, and the bundle id are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-apple-credentials`:

```
pithy secrets create auth-apple-credentials --env <env>
```

At a terminal it asks for the value, masked. An agent or a script pipes the JSON document in on stdin instead. `--json` only shapes the output, and the value is never read from a flag:

```
printf '%s' '{"clientId":"<services-id>","clientSecret":"<es256-jwt>","appBundleIdentifier":"<ios-bundle-id>"}' | pithy secrets create auth-apple-credentials --env <env>
```

`appBundleIdentifier` is optional. Omit it for web-only. The package reads the whole credential from the secrets store at request time and wires it into the provider. Enable Apple in config with `auth({ apple: { enabled: true } })` — no credential values in the config.

The secret is **rotatable**. When the JWT nears its six-month expiry, generate a fresh one and rotate the secret. Read sites stay byte-identical.

## Account linking

A user who signed up with a magic link and later signs in with Apple is linked automatically when the verified emails match. Apple is configured as a **trusted provider**, and the local email is already verified — the magic link proved it — so the two accounts merge into one rather than colliding.

Apple only returns the user's name on the **first** authorization. Better Auth persists it then. If you wipe the user and re-authorize, the name does not come back unless you remove the app from the Apple ID's signed-in apps first. There is nothing to configure; just know the name arrives once.

`requireLocalEmailVerified` stays on. That is the secure default: it blocks account takeover where an attacker pre-registers an unverified row for a victim's email and waits for the victim's Apple sign-in to link into it. Leave it on.

## When the credential will not read

An enabled provider whose secret is missing, or whose stored value no longer matches its schema, costs **that provider and nothing else**. Magic link, OTP, and every other provider keep signing people in.

A sign-in attempt with Apple then answers `503` with the code `auth/provider_unavailable` and a message naming apple, rather than the `404 PROVIDER_NOT_FOUND` a provider nobody enabled gets — the two are different facts and never share an answer. The attempt is recorded in the audit trail as `auth/provider_unavailable`, which is where an operator learns a sign-in method is down. Fix it by provisioning `auth-apple-credentials` for that environment, or turn the provider off in config.

## Checklist

- [ ] App ID registered with Sign in with Apple enabled; bundle id in hand.
- [ ] Services ID created with Sign in with Apple configured; web domain verified.
- [ ] Sign in with Apple key created; `.p8` downloaded, Key ID and Team ID noted.
- [ ] Client secret JWT generated: ES256, `iss` = Team ID, `sub` = Services ID, `aud` = `https://appleid.apple.com`, `exp` ≤ 6 months.
- [ ] Return URL registered per environment as `<baseURL><basePath>/callback/apple`.
- [ ] Return URL host matches each environment's `baseURL`; domain verified and https.
- [ ] The app's universal link origin, or its custom scheme, listed in `trustedOrigins` (no deep link in the Apple portal).
- [ ] `clientId` + `clientSecret` + optional `appBundleIdentifier` stored together via `pithy secrets create auth-apple-credentials` (typed JSON); Apple enabled in config with `apple: { enabled: true }`.
- [ ] A plan to regenerate and rotate the client secret before it expires.
- [ ] `requireLocalEmailVerified` left on.
