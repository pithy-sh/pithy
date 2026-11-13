# Native app attestation

_This copy ships in the package because `README.md` sends an adopter to it by name._

A web page proves a human is there with Turnstile. A native app has no widget to solve. It proves something else instead: that the request came from your app, unmodified, on a real device. Apple calls that App Attest. Google calls it Play Integrity. Auth's send routes take either one in place of a Turnstile token, once that platform's verifier ships. This release verifies Apple App Attest. [What this release verifies](#what-this-release-verifies) says what that means for Android.

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

A project that never configures attestation installs nothing new and mounts no new route. `pithy migrate` creates two tables, `pithy_auth_attestation_challenges` and `pithy_auth_app_attest_keys`, and nothing writes to either. Verification runs on WebCrypto, with auth's own CBOR and certificate reader, and `@pithy-sh/auth` takes no dependency for it.

## The flow

1. **Ask for a challenge.** `POST /auth/attestation/challenge` answers `{ challenge, expiresAt }`. The challenge is 32 random bytes as unpadded base64url. It is good once, until `expiresAt`. Auth stores only its SHA-256.
2. **Attest over the request.** Hash the challenge's characters followed by the send's exact body bytes with SHA-256. That digest is App Attest's `clientDataHash`, and its base64url is Play Integrity's `requestHash`. It binds the attestation to this challenge and this body, so it cannot be lifted onto another address.
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
| `auth/attestation_failed` | 403 | The attestation did not verify: a header that does not decode, a challenge that is stale, reused or never issued, a real assertion from a platform with no allowed app, an App Attest key that does not register, an assertion that does not check out, or the test assertion where it is not accepted. |
| `auth/attestation_config` | 500 | The server cannot judge it: the environment has no attestation block, or no verifier for the platform is available. |

Each one says why in `detail`, which goes to the operator's log and never to the client. The client sees the code, the status and a short message.

## What this release verifies

Apple App Attest, and the test assertion on either platform. A real Play Integrity token is answered with `auth/attestation_config` until the release that verifies Android.
