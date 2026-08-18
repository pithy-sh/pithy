# Google Play Billing

Wiring Google Play purchases into `@pithy-sh/payments`. Step by step.

Play is the rail with the most moving parts, and none of them is optional. A Play purchase token is a pointer, not a state, so payments has to ask the Play Developer API what it points at — which means a Google Cloud service account with the right grant. And Play's notifications arrive through Pub/Sub rather than from Play, which means a topic, a push subscription, and an audience. Get one of those wrong and purchases still work while renewals silently stop.

## Why this part is manual

Everything below is created in the [Play Console](https://play.google.com/console) and the [Google Cloud console](https://console.cloud.google.com) by a human with access to your developer account and your cloud project. Pithy cannot provision it for you — there is no API that links a service account to a Play developer account, and the Play Console's own API access page is deliberately a human decision. So this is a one-time manual setup per app. Everything after it is config.

## 1. Note your application id

Your Android application id — `com.example.myapp` — is the `packageName`. Every Play Developer API call is scoped to it, and every notification is checked against it. A notification for another app is refused with 401 even when Google signed it correctly, because a Google signature proves who delivered a notification and never what it is about.

## 2. Create the products

Under **Monetize** → **Products**, create your subscriptions and in-app products.

The id you give each one is what goes in `pithy.config.ts`. For a subscription that is the **subscription id** — `pro_monthly`, not the base plan id. For a one-time product it is the **product id**.

```ts
payments({
  rails: { google: true },
  products: {
    pro_monthly: {
      type: "subscription",
      name: "Pro",
      entitlements: ["pro"],
      google: { productId: "pro_monthly" },
    },
  },
});
```

The catalog is the only place a Play id appears. Gating code names `pro`.

## 3. Create a service account and grant it Play access

This is two consoles, and the second half is the step most often missed.

In the **Google Cloud console**, in the project you want to own the credential:

1. Enable the **Google Play Android Developer API**.
2. Under **IAM & Admin** → **Service accounts**, create a service account. No project roles are needed — its permissions come from the Play Console, not from IAM.
3. On that service account, create a **JSON key** and download it. You get it once.

Then in the **Play Console**, under **Users and permissions**, invite the service account's email address and grant it, at the app level:

- **View financial data, orders, and cancellation survey responses**
- **Manage orders and subscriptions**

Without the financial-data grant every purchase lookup answers 401, and payments reports `payments/provider_unavailable` with that hint in its `detail`. The grant can take a few hours to take effect. That is Google's own propagation, not a misconfiguration.

From the downloaded JSON key you need two fields: `client_email` (the `serviceAccountEmail`) and `private_key` (the `privateKey`). The private key is PKCS#8 — it begins `-----BEGIN PRIVATE KEY-----`. Store it with its newlines intact; escaped `\n` sequences are accepted too, since that is how the JSON file holds it.

## 4. Create the Pub/Sub topic

Real-time Developer Notifications are published to a Pub/Sub topic you own.

In the **Google Cloud console**, under **Pub/Sub** → **Topics**, create a topic — for example `pithy-payments-rtdn`. Then grant Google's publisher the right to write to it: on the topic's permissions, add the principal

```
google-play-developer-notifications@system.gserviceaccount.com
```

with the role **Pub/Sub Publisher**. Play will not accept the topic without it.

## 5. Point Play at the topic

In the **Play Console**, under **Monetize** → **Monetization setup**, paste the topic's full resource name into **Real-time developer notifications**:

```
projects/<gcp-project-id>/topics/pithy-payments-rtdn
```

Save, then use **Send test notification**. Payments records it and answers 200 with `projected: false` — a test notification is authentic and concerns no purchase, so there is nothing to project.

## 6. Create the push subscription, with an audience

This is where the security boundary lives.

Under **Pub/Sub** → **Subscriptions**, create a **push** subscription on the topic:

| Field | Value |
| --- | --- |
| Delivery type | Push |
| Endpoint URL | `https://<your-worker-host>/payments/webhooks/google` |
| Enable authentication | on |
| Service account | the service account from step 3 |
| Audience | the endpoint URL, exactly |

**The audience is not optional and it is not decoration.** Google signs the OIDC token on a push with the same handful of keys it uses for every Pub/Sub push subscription on the planet, so a valid signature says only that Google minted the token. The `aud` claim is what says it was minted for *your* endpoint. Payments checks it against the configured `pubsubAudience` and refuses a mismatch with 401 — which means an endpoint that skipped the check would accept notifications from any Google customer who pointed a subscription at it.

Payments also checks the token's `email` claim against the configured `serviceAccountEmail`, which is Google's own recommendation. Use the same service account for the push subscription and for the API grant, or the check will refuse legitimate deliveries.

One subscription per environment, each with its own endpoint and its own audience.

## 7. Set the account identifier in the app

Before launching Play's purchase flow, set the obfuscated account id:

```kotlin
BillingFlowParams.newBuilder()
  .setProductDetailsParamsList(params)
  .setObfuscatedAccountId(accountIdFromYourServer)   // a random per-subject value your server minted and stored
  .build()
```

**Make it a random value your server minted for the subject that will hold the purchase, and never a value anybody else can derive.** The subject is your user under `billingSubject: "user"` and the organization the buyer is acting for under `"organization"` — one identifier per subject either way, minted once and stored beside it. Not the subject's id, not a hash of an email or a domain. The identifier is what attributes a notification that arrives before the app has submitted anything, so a *guessable* one is a way to aim at a specific account: someone who can work out that subject's identifier could make one real purchase carrying it and claim the link first. Under organization billing the target is a whole company rather than one person, so a derivable identifier is worth more to an attacker, not less.

Payments narrows that in three ways, and none of them substitutes for an unguessable value. The identifier is set by the *app*, so it is never treated as a holder on its own — it ranks **below** both a purchase already projected for the subject an authenticated caller was acting for and the subscription family a renewal descends from. A binding is only written once a purchase has actually projected, so claiming one costs a real purchase rather than a free test one. And a binding is never rebound: the first pairing wins, and a collision is audited as `payments/provider_account_contested`.

An app that never sets it and never submits a receipt produces notifications with no subject to project them against, which payments records with a reason rather than guessing.

Payments does **not** acknowledge purchases. Your app does, through Play Billing, and it must: Play auto-refunds a purchase left unacknowledged for three days. Payments records the acknowledgement state and never acts on it, because acknowledging from a server would race the client that owns the purchase flow.

## Where the credentials live

**All four values travel as one typed JSON secret**, through `@pithy-sh/secrets` — never committed, never an env literal. Google's block sits inside `payments-provider-credentials` alongside any other rail's:

```sh
echo '{"google":{"packageName":"com.example.myapp","serviceAccountEmail":"<client_email>","privateKey":"-----BEGIN PRIVATE KEY-----\n…\n-----END PRIVATE KEY-----","pubsubAudience":"https://<host>/payments/webhooks/google"}}' \
  | pithy secrets create payments-provider-credentials --env staging
```

The value comes from stdin, or from a prompt at a terminal. The secret is environment-scoped, so `--env` is required and each environment holds its own. Write the key's newlines as `\n` inside the JSON string; the downloaded file already holds them that way.

A rail's block is present in full or absent entirely, and that is enforced where you can see it: the registry's schema is checked before the write lands, so half a credential is a refusal in your terminal rather than a lookup that silently never succeeds.

The secret is **rotatable**, per environment. Rotating a service-account key is a new JSON key in the cloud console and one `pithy secrets update payments-provider-credentials --env <env>`; read sites stay byte-identical.

Google's public verification keys are **not** here. They are published at `https://www.googleapis.com/oauth2/v3/certs`, fetched, and cached for an hour — with a refresh forced whenever a token names a key id the cache does not hold, which is what makes Google's key rotation invisible.

## What a notification actually does

Worth knowing, because it explains the failure modes:

1. Pub/Sub POSTs the push. Its `Authorization` header carries the OIDC token; the body carries a base64 Developer Notification.
2. Payments verifies the token — signature, issuer, audience, expiry, service account — and refuses with 401 if any of that fails. **Nothing is recorded for a delivery that fails this step**, so a forger cannot fill the table.
3. Payments decodes the notification and checks the package name.
4. The notification is a **pointer**. Payments calls the Play Developer API to find out what the purchase now is, and projects that.
5. The delivery is recorded either way, in `pithy_payments_webhook_events`. A delivery that projected carries `processedAt`; one that did not carries the reason and no `processedAt`, so Pub/Sub's next attempt — or your replay — runs it again.

So: a Play outage is a 503 and Pub/Sub redelivers. A purchase Play does not recognize is a 200 with the reason recorded, because retrying will not change the answer. Subscription refunds arrive as `SUBSCRIPTION_REVOKED` and project immediately.

A refunded **one-time** purchase takes a different route, because Play's voided-purchase notification names no product and Play's one-time lookup needs one as a path segment — so there is no call the rail can make. It does not need one: an order id is exactly what a Google purchase is keyed by here, so the notification's `orderId` finds the stored row, which already knows its product and the subject holding it. The refund is projected from that, and the entitlement goes with it. A void naming an order that was never projected — a purchase from before you installed payments — is recorded as orphaned with its order id rather than dropped.

## Testing without spending money

Add licence testers under **Users and permissions** → **Licence testing** in the Play Console. Their purchases are real Play purchases marked as test purchases, and payments treats every one of them as **sandbox** — a subscription carrying `testPurchase`, a one-time purchase with `purchaseType: 0`. A test purchase reaching a production deployment is refused with `payments/environment_mismatch` and grants nothing. That is deliberate and it is the single most common in-app-purchase defect there is.

Point a staging deployment at the same Play app with its own Pub/Sub subscription and its own audience, and test purchases project there.

## Checklist

- [ ] Application id noted; it matches `packageName` in the secret.
- [ ] Products created in the Play Console; their ids in `pithy.config.ts` under each product's `google` block.
- [ ] Google Play Android Developer API enabled in the cloud project.
- [ ] Service account created; JSON key downloaded and kept safe.
- [ ] Service account invited in the Play Console with **View financial data** and **Manage orders and subscriptions**, at the app level.
- [ ] Pub/Sub topic created, with `google-play-developer-notifications@system.gserviceaccount.com` as a Publisher on it.
- [ ] Topic's resource name pasted into Monetization setup; test notification sent and answered 200.
- [ ] Push subscription created per environment: authentication on, the step-3 service account, and the **audience set to the endpoint URL exactly**.
- [ ] `setObfuscatedAccountId` set in the app's billing flow, from a **random per-subject value your server minted** — never the subject's id or anything derivable from it.
- [ ] The app acknowledges purchases through Play Billing.
- [ ] `packageName` + `serviceAccountEmail` + `privateKey` + `pubsubAudience` stored together via `pithy secrets create payments-provider-credentials`; `rails: { google: true }` in config.
- [ ] Licence testers added, and a staging deployment with its own subscription and audience to project their purchases.
