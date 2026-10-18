# Tiers, allowances and reported usage

_This copy ships in the package because `packages/payments/src/workflows/usage.ts` sends an adopter to it by name for the Workflow stanza._

What a key buys, how much one customer may have, what the kit counts for you, and how to bill by a count your code owns. Four parts, each standing on the one before it.

## Part one — declare each entitlement once

A key is declared in the top-level `entitlements` map: its display name, its numbered `quotas`, its `features`. A product goes on mentioning the keys it grants, as an array of strings. The declaration is top-level because a tier is sold by more than one product — `growth_monthly` and `growth_annual` are two SKUs for one tier, and the numbers belong to the tier.

```ts
payments({
  billingSubject: "organization",
  resolveSubject,

  entitlements: {
    start: {
      name: "Start",
      quotas: { emails: 500, projects: 3, seats: 2 },
      features: { sso: false, auditExport: false },
    },
    growth: {
      name: "Growth",
      quotas: { emails: 5000, projects: 10, seats: 10 },
      features: { sso: true, auditExport: false },
      overrideMax: { emails: 100_000 },
    },
    scale: {
      name: "Scale",
      quotas: { emails: null, projects: null, seats: 50 },
      features: { sso: true, auditExport: true },
    },
    // Declared and sold by nothing: comp-only.
    enterprise: {
      name: "Enterprise",
      quotas: { emails: null, projects: null, seats: null },
      features: { sso: true, auditExport: true },
    },
  },

  // What a caller holding no key gets.
  defaults: {
    quotas: { emails: 50, projects: 1, seats: 1 },
    features: { sso: false, auditExport: false },
  },

  rails: { stripe: true },
  stripe: { successUrl, cancelUrl, portalReturnUrl },
  products: {
    start_monthly: { type: "subscription", name: "Start", entitlements: ["start"], stripe: { priceId: START } },
    growth_monthly: { type: "subscription", name: "Growth", entitlements: ["growth"], stripe: { priceId: GROWTH } },
    growth_annual: { type: "subscription", name: "Growth, yearly", entitlements: ["growth"], stripe: { priceId: GROWTH_YEAR } },
    scale_monthly: { type: "subscription", name: "Scale", entitlements: ["scale"], stripe: { priceId: SCALE } },
  },
});
```

**`quotas` holds whole numbers and `null`; `features` holds booleans.** `null` is unlimited, and it is written, never inferred. A quota that is a float, a negative or a string is refused at parse, naming the key and the name.

**A key a product mentions must be declared.** A mention with no declaration is refused at parse, naming the product and the key. The reverse is legal and means comp-only: `enterprise` above is grantable by hand and sold by no checkout. `manualEntitlements` is gone, and a config still passing it is refused with the declaration to write instead.

**`overrideMax` is optional, per quota.** It bounds what an operator may pin for a subject on that tier (part two). It must name a quota the key declares and must not sit below that quota's own value — a ceiling under the plan would refuse what the plan already grants.

### Reading an allowance

```ts
import { feature, quota } from "@pithy-sh/core/src/entitlement/allowance";

app.post("/projects", requireAuth(), validate("json", NewProject), async (c) => {
  const projects = await quota(c, "projects"); // a whole number, or null for unlimited
  if (projects !== null && (await countProjects(orgOf(c))) >= projects) throw new ProjectLimitReached();
  if (await feature(c, "auditExport")) enableExport();
  // …
});
```

**Neither reader takes a key.** A route does not know which tier the caller is on, and during an upgrade overlap the caller holds two. `quota(c, name)` resolves across every key the subject holds:

1. The subject's **override**, if it pins this name.
2. **`unrestricted`**, if the override carries it: unlimited, and on.
3. The **highest** value among every key the subject holds now — `null` beats every number, and a feature is on if any held key turns it on.
4. **`defaults`**, for a name no held key speaks to.
5. **`0` and `false`.** Never unlimited.

**A name nothing declares throws `core/internal`**, naming the name and listing the declared ones. `quota(c, "emals")` is a hard failure, never a zero and never unlimited.

**`requireEntitlement` still gates on the key alone.** A quota denies nothing by itself, and a feature set to `false` denies nothing either. What a number means for a request is your route's decision, because only your code can count what it owns. Payments never counts members.

**A paywall reads the same numbers.** `virtual:pithy/payments` carries what each tier buys, and `useAllowances()` reads what the caller resolves to. A UX affordance, never a security boundary — `docs/UI.md`.

## Part two — one subject's allowance, overridden from the control plane

An override shades one subject's numbers without taking them off their plan. Keyed on the subject, never on a key, so it survives a tier change.

```
growth plan:   emails 5000, projects 10, seats 10, sso true
override:      emails 20000

effective:     emails 20000    override
               projects 10     plan: growth
               seats 10        plan: growth

later, upgraded to scale:
effective:     emails 20000, projects unlimited, seats 50
```

Three control-plane writes, three scopes:

| Route | Scope | What it does |
| --- | --- | --- |
| `POST {base}/entitlements/overrides` | `payments:overrides:set` | Pin quotas or features by name. A merge: only the names sent change |
| `POST {base}/entitlements/overrides/unrestricted` | `payments:overrides:unrestricted` | Every quota unlimited and every feature on, for every name declared now or later — or take it back |
| `POST {base}/entitlements/overrides/clear` | `payments:overrides:clear` | Unpin names, or clear the whole override. Clearing nothing answers 200 |

```json
{
  "subjectType": "organization",
  "subjectId": "acme",
  "version": 0,
  "reason": "MSA signed 2026-06-01, ticket 4471",
  "quotas": { "emails": 20000 }
}
```

- **Version-checked.** Every read carries the subject's `overrideVersion`; a write must send it back. A write behind the row is `payments/override_stale` (409), and nothing is written — so two operators editing one customer cannot silently overwrite each other.
- **A reason is required**, and the audit event carries it verbatim beside the subject, the mode, the before and the after.
- **Bounded.** A number past the tier's `overrideMax` is a 400 naming the limit. Never clamped. A quota with no ceiling accepts any whole number.
- **Declared names only.** A name the declarations do not mention is a 400 naming it and listing what is declared.
- **It grants no key.** A subject with an override and no entitlement is refused at every gate. A comped key and a pinned number compose.
- **`unrestricted` is its own route and its own scope.** It is the largest grant the kit has, and the only one whose reach grows by itself as names are declared. It is never bounded by `overrideMax`. It is how an Enterprise contract is honored today, beside a comped `enterprise` key, and how an operator grants their own account the whole product.

**The reads.** `GET {base}/admin/entitlements/:subjectType/:subjectId` projects, per declared name, what applies now, where it came from — `unrestricted`, `override`, `plan` with the key, `default`, or `none` — and what it would be with the override removed. That last one is what a pane shows beside a pin and reverts to. `GET {base}/admin/overrides` pages every override, filterable to `unrestricted=true`. Every entitlement row says whether its holder is unrestricted, and `pithy doctor` names every unrestricted subject in every environment.

**The catalog read is the editor's input.** `GET {base}/admin/catalog` projects each declared key's name, quotas, features and `overrideMax`, plus the floor — every editable name, and whether it is a number or a switch, from one response.

## Part three — the kit counts what it owns

| Meter | Counted from | Enforced by |
| --- | --- | --- |
| `emails` | a per-period counter in `pithy_payments_meter_counters` | `@pithy-sh/email`, at enqueue |
| `storageBytes` | `pithy_storage_objects` | `@pithy-sh/storage`, as the per-owner ceiling in place of `bytesPerOwner` |
| `mediaItems` | `pithy_media_assets` | `@pithy-sh/media`, at create |

```ts
payments({
  // …
  meters: { emails: { enforce: true } },
});
```

**Every meter is advisory until named here.** Declaring `quotas: { emails: 500 }` makes 500 readable; enforcing the `emails` meter makes it binding. Two steps, because the first is a pricing decision and the second is a production one. An enforced meter with no quota of its name is refused at parse — it would refuse everyone.

**A refusal is `payments/quota_exceeded` (402)** — nothing is written — and an `unrestricted` subject is never refused by any meter. `storageBytes` keeps `@pithy-sh/storage`'s own `storage/quota_exceeded`: its ceiling is now the subject's quota where one is enforced, and `bytesPerOwner` where none is.

**An email is counted when you say whose it is.** Pass `subject` on the enqueue for mail a customer's plan pays for; the kit's own mail — a magic link to somebody who has not signed up — names nobody and is never counted.

```ts
await email.enqueue(c.env, {
  to,
  template: "operationalNotice",
  payload,
  subject: { subjectType: "organization", subjectId: org.id },
});
```

**The period** is the subscription's billing period where payments knows one and the calendar month (UTC) where it does not. A new period is a new counter row, so it starts at zero with nothing to reset it. The check and the charge are one statement, so concurrent sends cannot race past the limit.

**A counter read that fails refuses, and logs.** Over-counting briefly is recoverable; under-counting is not. The cost is real — a bug of ours becomes a refused send — and enforcement being opt-in is what bounds it. Leave a meter advisory to keep the check in your own route instead.

**A meter refuses; it never bills.** Nothing a meter counts is reported to a store. The kit does not sell overage.

## Part four — bill by a count your code owns

Payments asks your code how many and tells the store. It never counts your members.

```ts
payments({
  billingSubject: "organization",
  resolveSubject,
  entitlements: { pro: { name: "Pro", quotas: { seats: null } } },
  rails: { stripe: true },
  stripe: { successUrl, cancelUrl, portalReturnUrl },
  products: {
    academy_seats: {
      type: "subscription",
      name: "Academy",
      entitlements: ["pro"],
      stripe: { priceId: ACADEMY_METERED_PRICE },
      billing: {
        kind: "reported",
        unit: "student",
        cadence: "period-end", // or "daily-peak"
        min: 1,
        max: 500,
        rails: ["stripe"],
        stripe: { meterEventName: "academy_students" },
      },
    },
  },
  resolveQuantity: async (c, subject) => countActiveStudents(c.env, subject.subjectId),
});
```

**`resolveQuantity` rides on the options, beside `resolveSubject`, and never in config** — the config crosses a var as JSON and a function does not survive it. A reported product with no resolver is refused at boot, naming the product.

**`cadence`, per product.** `period-end` (the default) sends one count per subscription per billing period, in the period's last day. `daily-peak` keeps each day's high-water mark — a lower later answer never lowers it — and reports the day once it is over.

**What is never reported:**

- an answer of `undefined` — nothing for that subject that period, logged and counted as skipped. Never `0`.
- a non-integer, a negative, or a count outside `min` and `max` — skipped and named in the run's tally. Never clamped.
- a period already reported. One row per `(rail, subscription, period)`, claimed before the store is called, and its id sent as the store's idempotency key.

A resolver that throws for one subject does not stop the run. Every run is kept in `pithy_payments_usage_runs` with its tally and the subjects it did not report, at `GET {base}/admin/usage-runs` behind `payments:usage:read`. The subscription reads show the last count reported and when.

**The rails.** Stripe gets one Billing Meter event per report — the meter's own aggregation decides what the invoice bills — and its checkout sends a metered line with no quantity, which Stripe requires. Paddle gets a one-time charge of `billing.paddle.priceId` at the reported quantity on the next bill; nothing rewrites the subscription's items. Apple and Google have no seats and are refused at boot. Lemon Squeezy is deferred: its usage records attach to a subscription item the projection does not store.

### The Workflow is yours to export

The pass calls your `resolveQuantity`, which lives only in your Worker, so its class is exported from your own entry — five lines — and its body is the kit's:

```ts
// apps/api/src/index.ts, beside createEntrypoint
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { reportPaymentsUsage } from "@pithy-sh/payments/src/workflows/usage";

export class PaymentsUsageWorkflow extends WorkflowEntrypoint<Record<string, unknown>> {
  override run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return reportPaymentsUsage(this.env, event, step, NonRetryableError);
  }
}
```

```jsonc
// apps/api/wrangler.jsonc, in each environment's stanza
"workflows": [
  { "binding": "PAYMENTS_USAGE", "name": "acme-prod-payments-usage", "class_name": "PaymentsUsageWorkflow" }
],
"triggers": { "crons": ["15 * * * *"] }
```

Hourly, so a `daily-peak` day is sampled through the day and a `period-end` report lands in its period's last day whatever hour it ends at. `createEntrypoint` fires it on the cron, and `c.var.workflows.trigger("payments/usage", {})` runs it on demand.
