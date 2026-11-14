# Native app attestation

_This copy ships in the package because `README.md` sends an adopter to it by name._

A web page proves a human is there with Turnstile. A native app has no widget to solve. It proves something else instead: that the request came from your app, unmodified, on a real device. Apple calls that App Attest. Google calls it Play Integrity. Auth's send routes take either one in place of a Turnstile token, once that platform's verifier ships. This release ships the gate, the challenge and test mode, and verifies no real assertion yet; [What this release verifies](#what-this-release-verifies) says what that means today.

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

A project that never configures attestation installs nothing new and mounts no new route. `pithy migrate` creates the one new table, `pithy_auth_attestation_challenges`, and nothing writes to it. Verification runs on WebCrypto, and `@pithy-sh/auth` takes no dependency for it.

## The flow

1. **Ask for a challenge.** `POST /auth/attestation/challenge` answers `{ challenge, expiresAt }`. The challenge is 32 random bytes as unpadded base64url. It is good once, until `expiresAt`. Auth stores only its SHA-256.
2. **Attest over the request.** Hash the challenge's characters followed by the send's exact body bytes with SHA-256. That digest is App Attest's `clientDataHash`, and its base64url is Play Integrity's `requestHash`. It binds the attestation to this challenge and this body, so it cannot be lifted onto another address.
3. **Send it in one header.** `x-pithy-attestation` carries unpadded base64url over the JSON `{ "platform": "ios" | "android", "challenge": "…", "assertion": "…", "keyId": "…" }`. `assertion` is the App Attest attestation object or assertion, or the Play Integrity token, as the platform hands it over. `keyId` is App Attest's key identifier; Android has none.

The challenge is spent the moment it is presented, pass or fail. A failed attempt asks for a new one.

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
| `auth/attestation_failed` | 403 | The attestation did not verify: a header that does not decode, a challenge that is stale, reused or never issued, a real assertion from a platform with no allowed app, an assertion that does not check out, or the test assertion where it is not accepted. |
| `auth/attestation_config` | 500 | The server cannot judge it: the environment has no attestation block, or no verifier for the platform is available. |

Each one says why in `detail`, which goes to the operator's log and never to the client. The client sees the code, the status and a short message.

## The client

`@pithy-sh/auth/src/client/attestation` speaks this flow for a native app, and the React Native scaffold wires it for you ([`docs/UI.md`](../../../docs/UI.md) § *React Native*).

```ts
import { sendOtp } from "@pithy-sh/auth/src/client/api";
import { createAttestation, testAttester } from "@pithy-sh/auth/src/client/attestation";

const attestation = createAttestation({ ...session.options, attester: testAttester("ios") });
const sent = await sendOtp({ email, type: "sign-in" }, { ...session.options, attestation });
```

`createAttestation` asks the challenge route for a challenge before each send, hands the attester the challenge, the exact body and their binding, and puts the result in `x-pithy-attestation`. With `attestation` set, the send carries no Turnstile token. The attester is injected:

- **`testAttester(platform)`** sends the test assertion.
- **`appAttestAttester({ module, store })`** is App Attest. `module` is `@expo/app-integrity`, and `store` keeps the key id. A send with no registered key generates one and sends Apple's attestation of it, and the key is kept as registered only once that send succeeds; later sends assert with it. A key whose send did not succeed, lost on the network or refused for any reason, is never asserted with, and the next send generates another. A registered key the device can no longer assert with, after a reinstall, a restore or a migration, is dropped and a new one registered on the same send. The module hashes the string it is handed into `clientDataHash`, so it is handed the challenge followed by the body.
- **`playIntegrityAttester({ module, cloudProjectNumber })`** is Play Integrity. It prepares the token provider, again after any failure to prepare it or to get a token, and asks for a token whose `requestHash` is the binding's base64url.

`@pithy-sh/auth` never depends on `@expo/app-integrity`: the app installs it and passes it in. A web-only or server-only project installs nothing for attestation. Its peers are `expo` and `react-native` at any version, so the floor is the API: 0.1.9, an Expo SDK 54 release, is the first with the `Async` names this client calls. The scaffold pins `expo` `~57.0.31` and `@expo/app-integrity` `~57.0.2`.

**A refusal keeps its code.** A refused send answers an `AuthResult` whose `failure.code` is the gate's: `auth/attestation_failed`, `auth/attestation_missing`, `auth/attestation_config`, `turnstile/failed` or `turnstile/missing_token`. `isGateRefusal(failure)` says whether a refusal is the gate's, which a screen may show without telling a registered address from another. A device that would not attest is `client/attestation_unavailable`, and nothing was sent. On `auth/attestation_failed` the attestation is told, and App Attest drops its key so the next send registers a new one. On a send that succeeded it is told too, which is when App Attest keeps its key as registered.

## What this release verifies

This release ships the challenge, the gate, the test verifier and the codes. A real App Attest or Play Integrity assertion in an `enforce` environment is answered with `auth/attestation_config` until the release that verifies that platform. The client projection says so: under `enforce`, `attestation.platforms` is `true` only for a platform with an allowed app and a verifier, so until then the scaffolded app keeps Turnstile on both platforms.
