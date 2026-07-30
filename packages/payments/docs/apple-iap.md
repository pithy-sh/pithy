# Apple in-app purchase

Wiring App Store purchases into `@pithy-sh/payments`. Step by step.

Apple is the rail with the least network in it and the most identity. A StoreKit 2 transaction arrives already signed by Apple, so a client submission verifies offline against a certificate chain that ships with this package — no round trip, no credential, no store outage in the path. What Apple's credentials buy is the other two things: calling the App Store Server API on the reconciliation pass, and proving that a signed payload is about *your* app rather than somebody else's.

## Why this part is manual

Everything below is created in [App Store Connect](https://appstoreconnect.apple.com) and the [Apple Developer portal](https://developer.apple.com) by a human with access to your Apple Developer account. Pithy cannot provision it for you — there is no API that registers an app, creates an in-app purchase product, issues an App Store Connect API key, or sets a notification URL, and the `.p8` private key is downloadable exactly once. So this is a one-time manual setup per app. Everything after it is config.

## 1. Note your bundle id

Your app's bundle id — `com.example.myapp` — is the `bundleId`, and it is load-bearing rather than decorative.

Apple signs every developer's notifications and transactions with the **same certificate chain**. A valid signature therefore proves Apple signed the payload and says nothing about which app it came from. Without a bundle check, another developer's transaction verifies here, and any SKU string of theirs that happens to match your catalog becomes a free entitlement.

So payments checks it twice on a notification — the envelope's `data.bundleId` and the nested transaction's own — because a notification assembled around somebody else's transaction would pass a check on either one alone. A notification for another app is refused with 401, and a submitted transaction from one with 400.

## 2. Create the products

Under your app's **Monetization** section, create your subscriptions and in-app purchases. A subscription belongs to a subscription group; a consumable or non-consumable stands alone.

The **product id** you give each one — reverse-DNS by convention, `com.acme.pro.monthly` — is what goes in `pithy.config.ts`.

```ts
payments({
  rails: { apple: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      apple: { productId: "com.acme.pro.monthly" },
    },
  },
});
```

The catalog is the only place an App Store product id appears. Gating code names `pro`.

Match the `type` to what you created. It decides how a renewal and a restore behave, and it decides whether the reconciliation pass can ask Apple about the purchase at all — Apple's subscription endpoint speaks for auto-renewables and nothing else.

## 3. Create an App Store Connect API key

Under **Users and Access** → **Integrations** → **App Store Connect API**, generate a key with **In-App Purchase** access. That key type is scoped to exactly this work, which is why it is the one to use rather than a team key with a broader role.

Note three things, and the first is available only once:

- The **private key**, downloaded as a `.p8` file. Apple lets you download it a single time.
- The **Key ID**, shown on the key.
- The **Issuer ID**, shown at the top of the same page and shared across every key in the account.

Store the `.p8` **verbatim**, header and footer included — it begins `-----BEGIN PRIVATE KEY-----`. Payments imports it as PKCS#8 and refuses anything else with a message saying so. Escaped `\n` sequences are accepted too, since that is how a JSON secret holds a multi-line value.

Nothing about client submissions or webhooks needs this key. It is the credential for the App Store Server API, which the nightly reconciliation pass and `pithy payments reconcile` use to ask Apple what a subscription is doing now. A project that never provisions it still verifies receipts and accepts notifications; it simply cannot repair the subscription nothing arrived about.

## 4. Point Apple at the notification endpoint

Under your app's **App Information**, in **App Store Server Notifications**, set the **Version 2** URLs. There are two, and both matter:

| Field | Value |
| --- | --- |
| Production Server URL | `https://<your-worker-host>/payments/webhooks/apple` |
| Sandbox Server URL | `https://<staging-host>/payments/webhooks/apple` |

**Version 2 only.** Payments reads `responseBodyV2DecodedPayload` and nothing else; a Version 1 URL delivers a shape it will refuse.

The path follows `basePath`, so a project that moved its mount moves these URLs with it.

Then use **Request a Test Notification**. Payments records it and answers 200 with `projected: false` — a `TEST` notification is authentic and concerns no transaction, so there is nothing to project. A non-2xx here means the URL, the host, or the deployment is wrong, and it is much cheaper to find out now than on somebody's first renewal.

## 5. Set the account token in the app

Before presenting the purchase sheet, set the app account token on the purchase:

```swift
let result = try await product.purchase(options: [
  .appAccountToken(accountTokenFromYourServer)   // a random per-user UUID your server minted and stored
])
```

Apple requires a **UUID** here.

**Make it a random value your server minted for that user, and never a value anybody else can derive.** Do not use the user's id, an email hash, or anything a third party could compute — mint a random UUID per user, store it beside the user, and hand it to the app. This matters because the token is the only hook from an App Store purchase back to a Pithy user for a notification that arrives before the app has submitted anything, and a *guessable* token is a way to aim at a specific account: someone who can work out your user's token could make one real purchase carrying it and claim the link first.

Payments narrows that in three ways, and none of them substitutes for an unguessable token. The token is set by the *app*, which may put anything in it, so it is never treated as an owner on its own — it ranks **below** both a purchase already projected for an authenticated caller and the subscription family a renewal descends from. A binding is only written once a purchase has actually projected, so claiming one costs a real purchase on this deployment's own environment rather than a free sandbox receipt. And a binding is never rebound, so the first pairing wins and a collision is audited as `payments/provider_account_contested` rather than silently accepted.

The link is written when your app submits the transaction — not by the notification.

That gives your app one obligation beyond setting the token: submit the transaction to `POST /payments/purchases` at least once. Payments has two fallbacks for a notification whose token resolves nothing — a purchase already projected under the same transaction id, and the subscription family the renewal descends from through `originalTransactionId` — and both need somebody to have submitted the first purchase. An app that sets no token and submits nothing produces notifications with no user to project them against, which payments records with a reason rather than guessing.

Submitting is also what makes the purchase feel instant. StoreKit 2's transaction is a JWS Apple signed, so verification is local and offline, and the buyer sees their entitlement in the purchase flow rather than a second or two later when the notification lands. Nothing about correctness rests on it — the notification produces the identical row through the same idempotent writer.

Payments does **not** call `Transaction.finish()`, and your app must: an unfinished consumable is re-delivered to the app forever. Finish it once your own server has confirmed the purchase.

## Where the credentials live

**All four values travel as one typed JSON secret**, through `@pithy-sh/secrets` — never committed, never an env literal. Apple's block sits inside `payments-provider-credentials` alongside any other rail's:

```sh
echo '{"apple":{"bundleId":"com.example.myapp","keyId":"<key-id>","issuerId":"<issuer-id>","privateKey":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----"}}' \
  | pithy secrets create payments-provider-credentials --env staging
```

The value comes from stdin, or from a prompt at a terminal. The secret is environment-scoped, so `--env` is required and each environment holds its own. Write the `.p8`'s newlines as `\n` inside the JSON string; a literal `\n` sequence is accepted too, since that is how the file often arrives.

A rail's block is present in full or absent entirely, and that is enforced where you can see it: the registry's schema is checked before the write lands, so half a credential is a refusal in your terminal rather than a signature check that silently never passes.

The bundle id is in there with the credentials and it is not secret. It sits beside them because it is part of one app's identity at Apple: it is what every payload is checked against, and it is the `bid` claim the App Store Server API token carries. Splitting it into config would put one half of that identity in git and the other in the secrets store.

The secret is **rotatable**, per environment. Rotating an App Store Connect key is a new key in App Store Connect and one `pithy secrets update payments-provider-credentials --env <env>`; read sites stay byte-identical.

**Apple's root certificates are not here, because they are not secrets.** `AppleRootCA-G3` ships with the package as a pinned asset, base64 DER, with its fingerprint and the procedure for adding a successor recorded beside it. A root certificate is a public key with a name on it — the check does not depend on it being hidden, it depends on it being Apple's. Pinning is what makes it mean something: verifying a chain against whatever roots happen to be around would accept a notification signed by any CA at all.

## What a notification actually does

Worth knowing, because it explains the failure modes:

1. Apple POSTs a single JSON field, `signedPayload`, carrying the whole notification as a compact JWS.
2. Payments verifies it — the certificate chain in the `x5c` header, terminating in the pinned Apple root, then the signature over the exact received bytes — and refuses with 401 if any of that fails. **Nothing is recorded for a delivery that fails this step**, so a forger cannot fill the table.
3. The nested transaction is verified independently, against the same chain, and both bundle ids are checked against yours.
4. Apple's `notificationType` and `subtype` are mapped into the normalized status set, and the transaction is projected.
5. The delivery is recorded either way, in `pithy_payments_webhook_events`, keyed on Apple's `notificationUUID`, with `processedAt` and any reason it was not projected.

So: a redelivery of a notification already processed short-circuits with 200 and runs nothing, which is what makes Apple's at-least-once retries free. A notification type this build has never seen is recorded and answered 200 — Apple adds types, and answering non-2xx would make Apple retry it forever while reading as a broken endpoint. A sandbox transaction reaching a production deployment is 200, is not projected, and records `payments/environment_mismatch`.

**Two mappings are worth reading twice.** `DID_CHANGE_RENEWAL_STATUS` with `AUTO_RENEW_DISABLED` is `canceled`, and **`canceled` still grants** — a subscriber who declines the next period keeps the one they paid for, and `expiresAt` is what ends it. And `DID_FAIL_TO_RENEW` means two different things: with the `GRACE_PERIOD` subtype the billing-retry window is open and access continues, which is the whole point of grace; bare, there is no grace to run and access has already stopped.

**Identifiers, since they surface in your data.** Each renewal is its own transaction with its own id, which is what makes a `grants` clause credit once per billing period rather than once ever, and `originalTransactionId` is the family key tying every renewal back to the transaction that started the subscription.

## Testing without spending money

Create sandbox testers under **Users and Access** → **Sandbox** → **Test Accounts**, and sign in to one on a device under **Settings** → **Developer** → **Sandbox Apple Account**. Their purchases are real StoreKit transactions carrying `environment: "Sandbox"`.

Payments treats **anything that is not literally `Production` as sandbox**, and a sandbox transaction reaching a production deployment is refused with `payments/environment_mismatch` and grants nothing. That default is deliberate and it is the single most common in-app-purchase defect there is: the failure directions are not symmetric. Treating production as sandbox loses a purchase the reconciliation pass repairs; treating sandbox as production hands out real entitlements for test transactions.

A deployment is production only when its `ENVIRONMENT` var says `production`. Everything else — `staging`, `dev`, a var nobody set — is sandbox, so point the Sandbox Server URL at staging and sandbox purchases project there.

**Xcode's local StoreKit testing will not verify against a deployed Worker.** Transactions from a `.storekit` configuration file are signed by a per-machine root that exists only on that Mac, and the trust set here is Apple's pinned roots — additive for the test suite, and not reachable from `pithy.config.ts` by design, because a config key that widened a production trust boundary is a key somebody eventually sets. Use a sandbox Apple Account against a real sandbox purchase.

The App Store Server API has its own sandbox host, and the host is chosen from the **stored purchase's own environment** rather than from the deployment's. A production transaction id asked of the sandbox service is a 404, so getting that wrong would look like a subscription Apple has never heard of.

## What Pithy deliberately does not do

No purchase sheet — no Worker can present one, so StoreKit stays your app's. No `Transaction.finish()`, no consumption reporting, and no purchase acknowledgement: those race the client that owns the flow. No `verifyReceipt` — that endpoint is deprecated, and a StoreKit 2 signed transaction is stronger than what it returned. No promotional offers, introductory pricing, or trials as catalog concepts; a trial arrives as an ordinary subscription state and is handled as one.

## Checklist

- [ ] Bundle id noted; it matches `bundleId` in the secret.
- [ ] Products created in App Store Connect; their product ids in `pithy.config.ts` under each product's `apple` block, with a `type` matching what you created.
- [ ] App Store Connect API key generated with **In-App Purchase** access; `.p8` downloaded and kept safe.
- [ ] Key ID and Issuer ID noted.
- [ ] **Version 2** notification URLs set for production and sandbox, both pointing at `/payments/webhooks/apple`.
- [ ] Test notification requested and answered 200.
- [ ] `appAccountToken` set on every purchase the app starts, from a **random per-user UUID your server minted** — never the user id or anything derivable from it.
- [ ] The app submits its transaction to `POST /payments/purchases`, which is what writes the account link.
- [ ] The app calls `Transaction.finish()` once your server has confirmed the purchase.
- [ ] `bundleId` + `keyId` + `issuerId` + `privateKey` stored together via `pithy secrets create payments-provider-credentials`; `rails: { apple: true }` in config.
- [ ] Sandbox testers created, and a staging deployment with the Sandbox Server URL to project their purchases.
