# Native app attestation

_This copy ships in the package because `README.md` sends an adopter to it by name._

A web page proves a human is there with Turnstile. A native app has no widget to solve. It proves something else instead: that the request came from your app, unmodified, on a real device. Apple calls that App Attest. Google calls it Play Integrity. Auth's send routes take either one in place of a Turnstile token.

## What it gates

The two routes that send a sign-in email: `POST /auth/sign-in/magic-link` and `POST /auth/email-otp/send-verification-otp`. Signing up is the same two routes, so it is gated too. Nothing else.

## The rule: either passes

- **A request carrying an attestation is judged by attestation, and only by attestation.** If it fails, the request is refused. It never falls through to Turnstile.
- **A request without one goes to Turnstile** when turnstile is composed, exactly as before.
- **Without turnstile composed**, a request with no attestation is refused with `auth/attestation_missing` in an environment that has an attestation block, and passes in one that has none.

Attestation works with turnstile composed or not. A project that composes turnstile and attestation serves its web page and its app from one Worker.

## Configuring it

The block lives on `auth()`, per environment, keyed by the name the Worker is stamped with:

```ts
auth({
  baseURL: "https://api.example.com",
  attestation: {
    environments: {
      dev: { mode: "test" },
      staging: { mode: "test", ios: [{ teamId: "ABCDE12345", bundleId: "com.example.app" }] },
      prod: {
        mode: "enforce",
        ios: [{ teamId: "ABCDE12345", bundleId: "com.example.app" }],
        android: [{ packageName: "com.example.app" }],
      },
    },
  },
});
```

- **`environments.<env>.mode`** is `enforce` (the default) or `test`.
- **`environments.<env>.ios`** lists the iOS apps allowed to attest: the Apple Team ID and the bundle identifier.
- **`environments.<env>.android`** lists the Android apps allowed to attest: the package name.
- **`challengeExpiresIn`** is how long a challenge stays usable, in seconds. Five minutes by default, ten at most.

An `enforce` block must allow at least one app. A real assertion from a platform with no app listed is refused; the test assertion is judged by the mode and the environment alone. An environment with no block keeps its send routes exactly as they were.

A project that never configures attestation installs nothing new and mounts no new route. `pithy migrate` creates two tables, `pithy_auth_attestation_challenges` and `pithy_auth_app_attest_keys`, and nothing writes to either. Verification runs on WebCrypto, with auth's own CBOR and certificate reader for App Attest and auth's own JWT signer for Play Integrity, and `@pithy-sh/auth` takes no dependency for either.

## The flow

1. **Ask for a challenge.** `POST /auth/attestation/challenge` answers `{ challenge, expiresAt }`. The challenge is 32 random bytes as unpadded base64url. It is good once, until `expiresAt`. Auth stores only its SHA-256.
2. **Attest over the request.** Hash the challenge's characters followed by the send's exact body bytes with SHA-256. That digest is App Attest's `clientDataHash`, and its unpadded base64url is Play Integrity's `requestHash`. It binds the attestation to this challenge and this body, so it cannot be lifted onto another address.
3. **Send it in one header.** `x-pithy-attestation` carries unpadded base64url over the JSON `{ "platform": "ios" | "android", "challenge": "…", "assertion": "…", "keyId": "…" }`. `assertion` is the App Attest assertion from `generateAssertion`, or the Play Integrity token, as the platform hands it over. On iOS the key must already be registered: the attestation object from `attestKey` goes once to `POST /auth/attestation/ios/keys` (see [Registering a key](#registering-a-key)), never in this header. `keyId` is App Attest's key identifier; Android has none.

The challenge is spent the moment it is presented, pass or fail. A failed attempt asks for a new one.

## Apple App Attest

### What goes in config

Each iOS app is one entry in `ios`: `{ teamId, bundleId }`. Together they are the app's App ID, `<teamId>.<bundleId>`, and App Attest signs over its SHA-256.

- **`teamId`** is your Apple Developer Team ID: ten uppercase letters and digits, such as `ABCDE12345`. Find it at [developer.apple.com/account](https://developer.apple.com/account) under **Membership details**, or in Xcode on the target's **Signing & Capabilities** tab as the team's identifier. If the app's identifier in **Certificates, Identifiers & Profiles** shows an App ID prefix other than the Team ID, which only very old apps have, use that prefix.
- **`bundleId`** is the app's bundle identifier, such as `com.example.app`. Find it in Xcode on the target's **General** tab under **Identity**, or in an Expo app's `app.json` as `ios.bundleIdentifier`.

List every app that may attest in that environment. A staging build with its own bundle identifier is its own entry in the `staging` block.

The app needs the **App Attest** capability in Xcode, which adds the `com.apple.developer.devicecheck.appattest-environment` entitlement. Its value picks Apple's environment, and auth reads it from the attestation: `production` keys are accepted everywhere, and `development` keys only where the Worker's `ENVIRONMENT` is `dev`, `staging` or `feature`, the same rule test mode follows. A development key in `prod` is refused. TestFlight and App Store builds attest in `production`.

### Registering a key

Once per key, before its first assertion:

1. The app calls `generateKey()` and keeps the key id.
2. It asks `POST /auth/attestation/challenge` for a challenge.
3. It calls `attestKey(keyId, clientDataHash:)` with SHA-256 of the challenge's characters: the [binding](#the-flow) over the challenge and an empty body.
4. It sends `POST /auth/attestation/ios/keys` with `{ "challenge": "…", "keyId": "…", "attestation": "…" }`, the key id and the attestation object base64 as Apple hands them over.

Auth spends the challenge, then checks the attestation Apple's way: the certificate chain leads to Apple App Attestation Root CA, which ships pinned in the package; the certificate's nonce is bound to this challenge; the certificate's key hashes to the key id; the `rpIdHash` is SHA-256 of an allowed app's App ID; the counter is zero; the AAGUID is an environment accepted here; and the credential id is the key id. It stores the key id, the public key, the App ID, the environment and a counter of zero in `pithy_auth_app_attest_keys`. A key registers once: registering it again is refused, so its counter cannot be reset. A key names no person.

### Each send

The app calls `generateAssertion(keyId, clientDataHash:)` with the binding over a fresh challenge and the send's exact body, and sends the assertion as `assertion` with the key id as `keyId` in `x-pithy-attestation`. Auth finds the key, checks that its app is still allowed and that a development key is accepted here, checks the `rpIdHash`, verifies the signature over the binding with the stored public key, and requires the counter to rise above the stored one. Then it stores the new counter.

### Refusals

Every App Attest check that fails is `auth/attestation_failed`, and `detail` starts with the check that failed: `challenge`, `format`, `chain`, `nonce`, `keyId`, `key` (no key with that id is registered), `rpIdHash`, `aaguid`, `credentialId`, `signature` or `counter`. A request carrying no `keyId` fails on `keyId`. The gate's own refusals come before these and are worded as [the codes](#the-three-refusals) say: a header that does not decode, or a send from a platform with no allowed app. An environment with no attestation block answers `auth/attestation_config`, at the registration route as at a send.

## Google Play Integrity

### What goes in config

Each Android app is one entry in `android`: `{ packageName }`, the application id Google Play knows it by, such as `com.example.app`. Find it in `build.gradle` as `applicationId`, or in an Expo app's `app.json` as `android.package`. List every app that may attest in that environment.

### The service account

The Worker decodes each token through Google's `decodeIntegrityToken`, signed in as a Google Cloud service account. One service account serves every app in an environment.

1. **Create it.** In [Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts), pick the project the app uses for Play Integrity, or create one, and enable the **Google Play Integrity API** under **APIs & Services**. Under **IAM & Admin > Service accounts**, create a service account. It needs no role.
2. **Make a key.** On the service account, open **Keys**, choose **Add key > Create new key**, pick **JSON**, and save the file. It is the only copy.
3. **Link the project in Play Console.** In [Play Console](https://play.google.com/console), open the app, then **Test and release > App integrity > Play Integrity API**, and link the same Google Cloud project. The app requests tokens for that project's number, and only that project's service accounts can decode them.
4. **Store it.** Paste the whole JSON file as the `auth-play-integrity-service-account` secret, once per environment:

```bash
pithy secrets create auth-play-integrity-service-account --env prod < service-account.json
```

The key's `private_key` spans many lines, so the prompt asks for the file as one JSON document rather than field by field. Auth keeps `client_email`, `private_key`, `private_key_id`, `project_id`, `client_id`, `token_uri` and `type`, and drops the rest. `pithy secrets ls` lists the secret, and `pithy doctor` reports it missing, once any environment lists an Android app. Delete the downloaded file once it is stored.

To rotate, add a new key to the service account, store it with `pithy secrets update`, then delete the old key in Cloud Console.

### Each send

The app asks Play Integrity for a standard-request token whose `requestHash` is the unpadded base64url of the [binding](#the-flow), and sends the token as `assertion` in `x-pithy-attestation`, with no `keyId`. The Worker signs an RS256 assertion with the service account's key, exchanges it at Google's token endpoint for an access token, which the isolate reuses until a minute before it expires, and calls `decodeIntegrityToken` for each allowed package until one decodes. Then it requires, in order:

- **`requestHash`** in `requestDetails` to be the binding over this challenge and this body. A classic request's `nonce` is checked the same way when it carries no `requestHash`.
- **`requestPackageName`** to be the package Google decoded the token for.
- **`appRecognitionVerdict`** to be `PLAY_RECOGNIZED`.
- **`appIntegrity`**: its `packageName` to be that same package. `requestPackageName` is only what the caller asked for, so this is the check that ties the token to your app rather than to any app Google Play distributes.
- **`deviceIntegrity`** to include `MEETS_DEVICE_INTEGRITY`.
- **`timestamp`**: `timestampMillis` no more than five minutes old, and no more than a minute ahead of the Worker's clock.

The licensing and account verdicts are not checked.

### Refusals

A verdict that fails is `auth/attestation_failed`, and `detail` starts with the check: `decode` (Google would decode the token for no allowed package), `requestHash` or `nonce`, `requestPackageName`, `appRecognitionVerdict`, `appIntegrity`, `deviceIntegrity`, `timestamp`, or `format`.

A fault in the server's setup is `auth/attestation_config` and never blames the user: no service account stored, a key that is not an RSA PEM, Google's token endpoint refusing the account, or `decodeIntegrityToken` answering 401, 403 or 404, which means the API is not enabled or the project is not linked to the app. Google failing outright, unreachable, a 429 or a 5xx, or an answer with no token or payload in it, is `core/upstream_failed` (502), and a call that runs past ten seconds is `core/upstream_timeout` (504).

## Test mode

Simulators, emulators and CI cannot produce a real attestation. In an environment set to `test`, the gate also accepts the test assertion from either platform:

```
pithy-test-attestation
```

Send it as `assertion`, with a real challenge from the challenge route. The challenge is still single-use and still expires.

**Production never accepts it.** The Worker accepts the test assertion only where its `ENVIRONMENT` is `dev`, `staging` or `feature`, whatever the config says. Everywhere else it is refused: `prod`, an unstamped Worker, and every name a project declares, because a deployed Worker cannot read `seed.productionEnvironments` to tell a declared production name from any other. Test mode in a declared environment is therefore inert; use `staging` or a feature deployment for simulators and CI. `pithy doctor` reports a production environment set to `test`, and `pithy deploy` refuses to ship one. Both hold every name in the root config's `seed.productionEnvironments` to the same rule.

## The three refusals

| Code | Status | When |
|---|---|---|
| `auth/attestation_missing` | 400 | The environment has a block, turnstile is not composed, and the request carried no attestation. |
| `auth/attestation_failed` | 403 | The attestation did not verify: a header that does not decode, a challenge that is stale, reused or never issued, a real assertion from a platform with no allowed app, an App Attest key that does not register, an assertion that does not check out, a Play Integrity verdict that fails, or the test assertion where it is not accepted. |
| `auth/attestation_config` | 500 | The server cannot judge it: the environment has no attestation block, no verifier for the platform is available, or the Play Integrity service account is missing or refused by Google. |

Each one says why in `detail`, which goes to the operator's log and never to the client. The client sees the code, the status and a short message.

## The client

`@pithy-sh/auth/src/client/attestation` speaks this flow for a native app, and the React Native scaffold wires it for you ([`docs/UI.md`](../../../docs/UI.md) § *React Native*).

```ts
import { sendOtp } from "@pithy-sh/auth/src/client/api";
import { createAttestation, testAttester } from "@pithy-sh/auth/src/client/attestation";

const attestation = createAttestation({ ...session.options, attester: testAttester("ios") });
const sent = await sendOtp({ email, type: "sign-in" }, { ...session.options, attestation });
```

`createAttestation` asks the challenge route for a challenge before each send, hands the attester the challenge, the exact body, their binding and a transport for any call it must make first, and puts the result in `x-pithy-attestation`. With `attestation` set, the send carries no Turnstile token. The attester is injected:

- **`testAttester(platform)`** sends the test assertion.
- **`appAttestAttester({ module, store })`** is App Attest. `module` is `@expo/app-integrity`, and `store` keeps the key id. With no registered key, a send first [registers one](#registering-a-key): it calls `generateKeyAsync`, asks the challenge route for a challenge of its own, calls `attestKeyAsync` with that challenge, and posts the challenge, the key id and the attestation object to `POST /auth/attestation/ios/keys`. The key id goes into `store` only when that route answers success. Then the send, and every later one, calls `generateAssertionAsync` over its own challenge and the exact body and sends the assertion in the header. A registration the route refuses is not kept, the send answers the route's code with nothing sent, and the next send registers a new key. A key the device can no longer assert with, after a reinstall, a restore or a migration, is dropped and a new one registered on the same send. The module hashes the string it is handed into `clientDataHash`, so registration hands it the challenge alone and an assertion the challenge followed by the body: the two bindings auth checks.
- **`playIntegrityAttester({ module, cloudProjectNumber })`** is Play Integrity. It prepares the token provider, again after any failure to prepare it or to get a token, and asks for a token whose `requestHash` is the binding's base64url.

`@pithy-sh/auth` never depends on `@expo/app-integrity`: the app installs it and passes it in. A web-only or server-only project installs nothing for attestation. Its peers are `expo` and `react-native` at any version, so the floor is the API: 0.1.9, an Expo SDK 54 release, is the first with the `Async` names this client calls. The scaffold pins `expo` `~57.0.31` and `@expo/app-integrity` `~57.0.2`.

**A refusal keeps its code.** A refused send answers an `AuthResult` whose `failure.code` is the gate's: `auth/attestation_failed`, `auth/attestation_missing`, `auth/attestation_config`, `turnstile/failed` or `turnstile/missing_token`. `isGateRefusal(failure)` says whether a refusal is the gate's, which a screen may show without telling a registered address from another. A device that would not attest is `client/attestation_unavailable`, and nothing was sent. On `auth/attestation_failed` at a send the attestation is told which send was refused, and App Attest drops the key that send used, never a newer one another send registered since, so the next send registers a new one. A refused registration answers the registration route's code, and the send is never made.
