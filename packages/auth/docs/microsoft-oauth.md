# Microsoft sign-in

_This copy ships in the package because `packages/auth/src/capability.ts` sends an adopter to it by name._

Adding Microsoft to `@pithy-sh/auth`: work, school, and personal accounts, through Microsoft Entra ID. Step by step.

## Why this part is manual

An Entra ID app registration is made in the Microsoft Entra admin center by a human with access to your directory. Pithy cannot create one for you. So this is a one-time manual setup. The rest of the flow is config.

## 1. Register an application

Open the [Microsoft Entra admin center](https://entra.microsoft.com) and go to **Entra ID → App registrations → New registration**.

- **Name**: whatever your users should see on the consent screen.
- **Supported account types**: who may sign in. This must agree with the `tenantId` you store — see [Choose the tenant](#3-choose-the-tenant).
- **Redirect URI**: platform **Web**, and the exact URI from the next section.

On register you get an **Application (client) ID** and a **Directory (tenant) ID** on the overview page. Where each goes is in [Where the credentials live](#where-the-credentials-live).

## 2. The exact redirect URI

Better Auth's OAuth `redirect_uri` is always:

```
<baseURL><basePath>/callback/microsoft
```

With the default `basePath` of `/auth`, the path is `/auth/callback/microsoft`. Under **Authentication → Web → Redirect URIs**, register one per environment, each on that environment's `baseURL` host:

| Environment | Redirect URI |
| --- | --- |
| dev | `http://localhost:8787/auth/callback/microsoft` |
| staging | `https://staging.<your-domain>/auth/callback/microsoft` |
| production | `https://<your-domain>/auth/callback/microsoft` |

Use your actual local port for dev — `8787` is wrangler's default, not a guarantee. Entra accepts `http://` for `localhost` only; every other host must be HTTPS. One registration can list every environment's URI, but a registration per environment keeps a staging secret from ever signing anyone into production.

### Every environment — and why feature-branch previews won't work

Entra only redirects to a URI the registration lists. Anything else is refused on Microsoft's own page, before your Worker is reached.

This bites feature-branch previews. A branch deployed to a Cloudflare preview URL — an ephemeral `*.workers.dev` or preview alias, not your registered `staging.<your-domain>` — is a host the registration has never seen, so Microsoft sign-in there fails. Add that deployment's own `<its-url>/auth/callback/microsoft` to the registration **and** point that deployment's `baseURL` at the same host, or run the flow against your registered `staging` environment instead.

Magic link and email OTP have no redirect URI — they work on any URL, preview or not. Only the OAuth providers need a registered callback.

## 3. Choose the tenant

`tenantId` says which accounts may sign in, and it must match the registration's **Supported account types**. A mismatch is refused by Microsoft, not by Pithy.

| Who signs in | Supported account types | `tenantId` |
| --- | --- | --- |
| One organization | Accounts in this organizational directory only | the **Directory (tenant) ID** |
| Any work or school account | Accounts in any organizational directory | `organizations` |
| Work, school, and personal accounts | Accounts in any organizational directory and personal Microsoft accounts | `common` |
| Personal accounts only | Personal Microsoft accounts only | `consumers` |

A single-tenant app is the narrowest door, and the safest default for an internal tool. `tenantId` is required. An empty one is refused when the secret is stored, because Better Auth would otherwise fall back to `common` without saying so.

## 4. Create a client secret

Under **Certificates & secrets → Client secrets → New client secret**, pick an expiry and add it. Copy the **Value** — not the **Secret ID** — the moment it appears. Entra shows it once.

Entra client secrets expire, 24 months at the longest. Rotate before the date: add a second secret, update `auth-microsoft-credentials`, then delete the old one.

## 5. Turn on `xms_edov`

**Do this step. It is what lets a work or school address link on the first sign-in.**

Entra ID cannot vouch for an email it did not verify. A work or school ID token carries no `email_verified` claim, and its `email` is the directory's `mail` attribute — which a tenant admin can set to any string, including your customer's address at a domain they do not own. Microsoft's own claims reference says not to use it for authorization. So Pithy treats a Microsoft address as unverified unless Microsoft says otherwise.

`xms_edov` — "email domain owner verified" — is how Microsoft says otherwise. When it is `true`, the user's tenant has verified ownership of the address's domain, so the address cannot be a stranger's. It is an optional claim, off until you ask for it:

1. Open the registration and go to **Manage → Token configuration**.
2. Select **Add optional claim**.
3. Choose token type **ID**.
4. Tick **xms_edov**, then **Add**.

Or in **Manage → Manifest**, add it to the ID token's optional claims:

```json
"optionalClaims": {
  "idToken": [{ "name": "xms_edov", "essential": false }]
}
```

That is the whole of it. `xms_edov` is only issued alongside an `email` claim, and Pithy requests the `email` scope, which supplies one. No claims-mapping policy is involved, so `acceptMappedClaims` stays as it is. Adding the `email` optional claim as well is harmless.

**Skip it, and here is what you get.** Every work and school address is unverified. A first Microsoft sign-in at an address that already has an account here is refused, and so is one at an address that has none — the same neutral answer either way, so nobody learns which addresses exist. The person signs in with a magic link to that address, then connects Microsoft from their account. From then on Microsoft signs them straight in. Personal accounts are unaffected, and so is anyone already connected. The cost is one magic link, once, per person.

Even with the claim on, a guest from another tenant, or an address whose domain the user's tenant has not verified, carries `xms_edov: false` and takes the same route.

## 6. Scope and profile

Pithy requests `openid`, `profile`, `email`, `User.Read`, and `offline_access` — Better Auth's defaults for Microsoft. You do not configure scopes anywhere.

Pithy does not fetch the profile photo from Microsoft Graph. Better Auth stores it in a shape the kit's image rule refuses, so it would be discarded on every sign-in. A Microsoft user starts with initials, and can set a picture in your app.

A directory user with no `mail` attribute arrives with no email at all. That sign-in is refused, because there is no address to own an account by.

## 7. Mobile

You do not register a deep-link URI with Microsoft. Microsoft only ever redirects to the Worker's `/auth/callback/microsoft`. The app opens `GET /auth/sign-in/social/start?provider=microsoft&callbackURL=…` in the system browser's sign-in sheet, never posting `/auth/sign-in/social` itself. `callbackURL` is the app's own link, `myapp://auth/callback` or a universal link, carrying the S256 challenge of a verifier only the app holds as `handoff_challenge`. The Worker completes the exchange and returns to that link with a one-time `?code=`, which the app trades with the verifier at `POST /auth/handoff` for the session token. [`apple-signin.md`](apple-signin.md) §6 has the steps, and `pithy ui add react-native` scaffolds them. The link must be in `trustedOrigins`, the scheme by prefix and an https link by its origin:

```ts
auth({
  trustedOrigins: ["myapp://", "https://app.example.com"],
});
```

## Where the credentials live

**All three values travel as one typed JSON secret.** The client id, client secret and tenant are stored together — through `@pithy-sh/secrets`, never committed, never an env literal — as `auth-microsoft-credentials`. The tenant rides with them because it means nothing apart from the registration it belongs to:

```
pithy secrets create auth-microsoft-credentials --env <env>
```

At a terminal it asks for the value, masked. An agent or a script pipes the JSON document in on stdin instead. `--json` only shapes the output, and the value is never read from a flag:

```
printf '%s' '{"clientId":"<application-client-id>","clientSecret":"<client-secret-value>","tenantId":"<directory-tenant-id-or-common>"}' | pithy secrets create auth-microsoft-credentials --env <env>
```

Enable Microsoft in config with `auth({ microsoft: { enabled: true } })` — no credential values in the config.

## Account linking

One account per verified email. Microsoft is **not** a trusted provider, and never will be: whether its address is verified is decided per sign-in, from claims Microsoft computes and a tenant cannot write.

A Microsoft address is verified when, and only when:

- the ID token carries `xms_edov: true`, or
- the token's `tid` is `9188040d-6c67-4c5b-b112-36a304b66dad`, the tenant every personal Microsoft account signs in under. A personal account has no directory and no admin, and its address is the account itself, confirmed by Microsoft at sign-up, or
- you are connecting Microsoft from inside your account, and its address is the one your account already holds. The magic link you signed in with proved it.

Anything else is unverified: the claim absent, `false`, the string `"true"`, or an `email_verified` Entra does not issue. Absence is never read as verification.

- **Verified address → automatic link.** It links into the account at that address. No second account.
- **Unverified address → verify first.** It neither links nor creates an account. Sign in with a magic link to that address, then connect Microsoft from your account. If no account exists yet, the magic link creates it.
- **Connected → signs in on the account, not the address.** Sign-in then resolves by Microsoft's `oid`, which is immutable and never reused. A later change to the directory's `mail` attribute changes nothing.

Connecting from inside your account requires a recent sign-in, as every provider change does, and a different unverified address is refused there too.

### Turning Microsoft sign-up off

`allowSignUp` is per provider, so a project can let email create accounts while Microsoft may only sign existing ones in:

```ts
auth({
  disableSignUp: false,                               // email may create an account
  microsoft: { enabled: true, allowSignUp: false },   // Microsoft may not
});
```

## When the credential will not read

An enabled provider whose secret is missing, or whose stored value no longer matches its schema, costs **that provider and nothing else**. Magic link, OTP, and every other provider keep signing people in.

A sign-in attempt with Microsoft then answers `503` with the code `auth/provider_unavailable` and a message naming microsoft, rather than the `404 PROVIDER_NOT_FOUND` a provider nobody enabled gets — the two are different facts and never share an answer. The attempt is recorded in the audit trail as `auth/provider_unavailable`, which is where an operator learns a sign-in method is down. Fix it by provisioning `auth-microsoft-credentials` for that environment, or turn the provider off in config.

## Checklist

- [ ] App registration created, its **Supported account types** chosen for who should sign in.
- [ ] Redirect URI `<baseURL><basePath>/callback/microsoft` registered for each environment, platform **Web**.
- [ ] Client secret created, its **Value** copied, and its expiry on somebody's calendar.
- [ ] `xms_edov` added to the ID token under **Token configuration** — or the magic-link step accepted for every work and school address.
- [ ] The app's scheme, and its universal-link origin when it has one, listed in `trustedOrigins` (no deep link in Microsoft).
- [ ] `clientId` + `clientSecret` + `tenantId` stored together via `pithy secrets create auth-microsoft-credentials` (typed JSON); Microsoft enabled in config with `microsoft: { enabled: true }`.
- [ ] Decided whether Microsoft may create accounts — `microsoft: { allowSignUp: false }` if it may not.

## Sources

- The `tid` personal-accounts value, and why `email` cannot authorize: [ID token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
- `xms_edov`, and that it requires the `email` claim: [Optional claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims-reference).
- Adding an optional claim in the portal or the manifest: [Configure optional claims](https://learn.microsoft.com/en-us/entra/identity-platform/optional-claims).
- The logo and the words on the button: [Sign in with Microsoft branding guidelines](https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps).
