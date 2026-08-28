// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { encodeSubjectReference } from "../../data/subject";
import { PaymentsVerificationFailedError } from "../../error/errors";
import { BROWSER_ITEMS_FORGERY, BROWSER_OVERWROTE_SERVER_STAMP } from "./fixtures/browserForged";
import {
  PADDLE_PAUSE_RESUME_AT,
  PADDLE_PAUSED_INDEFINITELY,
  PADDLE_PAUSED_WITH_RESUME_DATE,
} from "./fixtures/pausedSubscription";
import {
  accountReferenceOf,
  accountReferenceProof,
  fencedOut,
  minorAmount,
  PADDLE_CUSTOM_ACCOUNT,
  PADDLE_CUSTOM_ENV,
  PADDLE_CUSTOM_PROOF,
  PaddleSubscription,
  PaddleSubscriptionPreview,
  PaddleTransaction,
  subscriptionEvent,
  subscriptionPendingChange,
  subscriptionResumesAt,
  transactionEvent,
} from "./objects";

/**
 * What a browser can write into `custom_data`, and what it is worth when it arrives back.
 *
 * `checkout.test.ts` covers what this deployment stamps and `routes.workers.test.ts` covers what the
 * routes do with a stamp. This file is about the attacker's half, and it runs against two objects Paddle
 * actually stored rather than two an author typed — see `fixtures/browserForged.ts` for how they were
 * produced.
 *
 * Nothing here contacts Paddle. The fixtures are the contact, made once, recorded.
 */

/** This deployment's notification-destination secret, and the only thing an attacker does not have. */
const SECRET = "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly";

describe("a stamp a browser wrote binds nobody", () => {
  test("the items[] forgery, exactly as Paddle stored it", async () => {
    // A page opened a checkout for a price it named, wrote an owner it chose, and paid. There was no
    // server call anywhere in that sentence, and this is the object that came back.
    expect(await accountReferenceOf(BROWSER_ITEMS_FORGERY, "prod", SECRET)).toBeNull();
  });

  test("the overwrite of a stamp this deployment really wrote", async () => {
    // The one that refutes the issue's premise. The transaction was created by the server, with a
    // server-written stamp on it; the browser passed `customData` beside `transactionId` and replaced it.
    // If `transactionId` protected `custom_data`, this fixture could not exist.
    expect(await accountReferenceOf(BROWSER_OVERWROTE_SERVER_STAMP, "prod", SECRET)).toBeNull();
  });

  test("both carry the right key names and the right environment — only the MAC refuses them", async () => {
    // Anti-vacuity of the strictest kind available here: the two refusals above must be the MAC failing
    // and not a missing key or a wrong environment, or they would prove nothing about the MAC at all.
    for (const forged of [BROWSER_ITEMS_FORGERY, BROWSER_OVERWROTE_SERVER_STAMP]) {
      expect(Object.keys(forged).sort()).toEqual(
        [PADDLE_CUSTOM_ACCOUNT, PADDLE_CUSTOM_ENV, PADDLE_CUSTOM_PROOF].sort(),
      );
      expect(forged[PADDLE_CUSTOM_ENV]).toBe("prod");
      expect(typeof forged[PADDLE_CUSTOM_ACCOUNT]).toBe("string");

      // And with the one value they could not produce, the identical object is honored. So the field
      // that decides is the proof, and every other field in these fixtures is already right.
      //
      // The owner the fixtures carry is a bare id — they were recorded before subjects existed, and a
      // browser writes whatever it likes anyway — so the honored form encodes it. That is the shape our
      // own checkout stamps, and the only shape the reader honors.
      const reference = encodeSubjectReference({
        subjectType: "user",
        subjectId: String(forged[PADDLE_CUSTOM_ACCOUNT]),
      });
      const proven = {
        ...forged,
        [PADDLE_CUSTOM_ACCOUNT]: reference,
        [PADDLE_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", SECRET),
      };
      expect(await accountReferenceOf(proven, "prod", SECRET)).toBe(reference);
    }
  });

  test("neither is fenced out, so the refusal is authorization and not the environment stamp", async () => {
    // `fencedOut` is a fence between deployments sharing one sandbox, not an authorization — it reads
    // unauthenticated `custom_data` on purpose. Both fixtures name this deployment's environment, so the
    // fence lets them through and `accountReferenceOf` is what stops them. Were it otherwise, the two
    // refusals above would be a forger declining to be projected rather than a forgery being caught.
    expect(fencedOut(BROWSER_ITEMS_FORGERY, "prod")).toBe(false);
    expect(fencedOut(BROWSER_OVERWROTE_SERVER_STAMP, "prod")).toBe(false);
  });

  test("a deployment that does not know its own environment trusts neither, and no proof helps", async () => {
    const reference = encodeSubjectReference({
      subjectType: "user",
      subjectId: String(BROWSER_ITEMS_FORGERY[PADDLE_CUSTOM_ACCOUNT]),
    });
    const proven = {
      ...BROWSER_ITEMS_FORGERY,
      [PADDLE_CUSTOM_ACCOUNT]: reference,
      [PADDLE_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", SECRET),
    };
    expect(await accountReferenceOf(proven, undefined, SECRET)).toBeNull();
  });

  test("a proven stamp that is not the subject encoding names nobody", async () => {
    // The second gate, and it is not the MAC. A stamp can be authentic — minted with this deployment's own
    // secret, for this deployment's own environment — and still name nobody, because a bare id is what
    // every pre-subject build wrote and reading one as a user attributes a purchase to whoever holds that
    // id. Both halves or neither. See `data/subject.ts`.
    for (const bare of ["ada", "team:ada", ":ada", "user:"]) {
      const stamp = {
        [PADDLE_CUSTOM_ACCOUNT]: bare,
        [PADDLE_CUSTOM_ENV]: "prod",
        [PADDLE_CUSTOM_PROOF]: await accountReferenceProof(bare, "prod", SECRET),
      };
      expect(await accountReferenceOf(stamp, "prod", SECRET), bare).toBeNull();
    }
  });
});

/**
 * When a paused Paddle subscription comes back (#369).
 *
 * Every input is `fixtures/pausedSubscription.ts` — two objects Paddle stored and handed back, not two an
 * author typed. The expectation is the literal string that went into the pause request, so the assertion
 * cannot be satisfied by any date this package could compute from the fixture's other fields.
 */
describe("a paused subscription says when it resumes", () => {
  const OCCURRED = new Date("2026-08-15T13:43:55.956Z");

  test("the date is on the `resume` scheduled change, and `resume_at` beside it is null", () => {
    // The recording that refutes the obvious fix. A change keyed on `scheduled_change.resume_at` — which
    // is how the issue describes this rail — would read null here and look correct while shipping nothing.
    expect(PADDLE_PAUSED_WITH_RESUME_DATE.scheduled_change.resume_at).toBeNull();
    expect(PADDLE_PAUSED_WITH_RESUME_DATE.scheduled_change.action).toBe("resume");
    expect(subscriptionResumesAt(PaddleSubscription.parse(PADDLE_PAUSED_WITH_RESUME_DATE))).toBe(
      "2026-10-01T00:00:00Z",
    );
  });

  test("so the projected event carries Paddle's own instant", () => {
    const event = subscriptionEvent(PaddleSubscription.parse(PADDLE_PAUSED_WITH_RESUME_DATE), OCCURRED, "sandbox");
    expect(event.status).toBe("paused");
    expect(event.resumesAt).toEqual(new Date(PADDLE_PAUSE_RESUME_AT));
    // Not the period end, which the same fixture carries and which is a different date entirely. Reaching
    // for it is what would have put a wrong date in front of a paying customer.
    expect(event.resumesAt).not.toEqual(new Date(PADDLE_PAUSED_WITH_RESUME_DATE.current_billing_period.ends_at));
  });

  test("a pause Paddle put no end on is indefinite, and reads as one", () => {
    // `scheduled_change: null` on a paused subscription. Null here is Paddle saying "until they ask",
    // which a consumer must be able to tell from "not paused" — the status is what does that.
    const event = subscriptionEvent(PaddleSubscription.parse(PADDLE_PAUSED_INDEFINITELY), OCCURRED, "sandbox");
    expect(event.status).toBe("paused");
    expect(event.resumesAt).toBeNull();
  });

  test("a scheduled cancel or pause is not a resumption, whatever date it carries", () => {
    // `effective_at` means something different per action: when access ends on a `cancel`, when the pause
    // begins on a `pause`. Only a `resume` names a return, and only a paused row may carry one.
    for (const action of ["cancel", "pause"]) {
      const scheduled = {
        ...PADDLE_PAUSED_WITH_RESUME_DATE,
        scheduled_change: { action, effective_at: "2026-12-01T00:00:00Z", resume_at: null },
      };
      expect(subscriptionResumesAt(PaddleSubscription.parse(scheduled)), action).toBeNull();
    }
  });

  test("a subscription still active with a pause scheduled carries no resume date on its row", () => {
    // This is where Paddle really does populate `resume_at` — and the subscription is `active`, so it has
    // not gone anywhere and nothing is coming back. The field is read, and the status is what withholds it.
    const scheduledPause = {
      ...PADDLE_PAUSED_WITH_RESUME_DATE,
      status: "active",
      scheduled_change: {
        action: "pause",
        effective_at: "2026-09-13T20:03:06.313818Z",
        resume_at: PADDLE_PAUSE_RESUME_AT,
      },
    };
    const parsed = PaddleSubscription.parse(scheduledPause);
    expect(subscriptionResumesAt(parsed)).toBe(PADDLE_PAUSE_RESUME_AT);
    expect(subscriptionEvent(parsed, OCCURRED, "sandbox").resumesAt).toBeNull();
  });

  test("an unreadable resume date is refused rather than stored as an Invalid Date", () => {
    const broken = {
      ...PADDLE_PAUSED_WITH_RESUME_DATE,
      scheduled_change: { action: "resume", effective_at: "soon", resume_at: null },
    };
    expect(() => subscriptionEvent(PaddleSubscription.parse(broken), OCCURRED, "sandbox")).toThrow(
      PaymentsVerificationFailedError,
    );
  });
});

/**
 * What Paddle answers when a plan change is previewed, and what it answers about one already scheduled
 * (#465).
 *
 * Every object below is a recording from the assigned sandbox on 2026-08-28 — Solo
 * `pri_01kzvyz9e21z9vbhd7xqq3csyh` at $6/mo, Team `pri_01kzvyz9khsdy36z10wb8bgmq4` at $110/mo, previewed
 * and scheduled through the API and read back. They sit here rather than in `fixtures/` because each is an
 * excerpt of one response, and the excerpt is what was measured; nothing has been filled in around them
 * except the two identity fields `PaddleSubscription` requires and no assertion reads.
 *
 * They are here because they refuted the first design of these shapes in four separate places, and each
 * refutation is a test: money is signed, `grand_total` lies on a downgrade, `next_billed_at` empties the
 * moment a cancellation is scheduled, and `immediate_transaction` is null whenever nothing settles today.
 */

/** Preview of the upgrade Solo → Team under `proration_billing_mode: "prorated_immediately"`. */
const PREVIEW_UPGRADE = {
  update_summary: {
    credit: { amount: "-380", currency_code: "USD" },
    charge: { amount: "6962", currency_code: "USD" },
    result: { action: "charge", amount: "6582", currency_code: "USD" },
  },
  immediate_transaction: {
    details: {
      totals: {
        subtotal: "6045",
        tax: "537",
        discount: "0",
        total: "6582",
        grand_total: "6582",
        grand_total_tax: "537",
        fee: null,
        credit: "0",
        credit_to_balance: "0",
        balance: "6582",
        earnings: null,
        currency_code: "USD",
        exchange_rate: "1",
      },
    },
    billing_period: { starts_at: "2026-08-28T11:13:32.939Z", ends_at: "2026-09-15T11:42:21.789736Z" },
  },
  // The recording elides the middle of this block. What is written is what was read, which is also the
  // case for a totals object that must parse with fields missing.
  recurring_transaction_details: {
    totals: { subtotal: "11000", tax: "976", grand_total: "11976", currency_code: "USD" },
  },
};

/** Preview of the downgrade Team → Solo under the same mode. The one where `grand_total` is not the answer. */
const PREVIEW_DOWNGRADE = {
  update_summary: {
    credit: { amount: "-6961", currency_code: "USD" },
    charge: { amount: "380", currency_code: "USD" },
    result: { action: "credit", amount: "6581", currency_code: "USD" },
  },
  immediate_transaction: {
    details: {
      totals: {
        subtotal: "-6045",
        tax: "-536",
        total: "-6581",
        grand_total: "0",
        grand_total_tax: "0",
        credit: "0",
        credit_to_balance: "6581",
        balance: "0",
        fee: null,
        earnings: null,
        currency_code: "USD",
        exchange_rate: "1",
      },
    },
  },
  recurring_transaction_details: {
    totals: { subtotal: "600", tax: "53", total: "653", grand_total: "653", currency_code: "USD" },
  },
};

/** The two fields `PaddleSubscription` requires and the recorded excerpts do not carry. Nothing asserts on them. */
const RECORDED_IDENTITY = { id: "sub_01kzvyzc4k9r0mm8b6ye2fq4rd", created_at: "2026-08-15T11:42:21.789Z" };

/** After `cancel({ effective_from: "next_billing_period" })`. Still active, and `next_billed_at` is gone. */
const SCHEDULED_CANCEL = {
  ...RECORDED_IDENTITY,
  status: "active",
  canceled_at: null,
  next_billed_at: null,
  scheduled_change: {
    action: "cancel",
    effective_at: "2026-09-15T11:42:21.789736Z",
    resume_at: null,
    items: null,
  },
  current_billing_period: { starts_at: "2026-08-15T11:42:21.789736Z", ends_at: "2026-09-15T11:42:21.789736Z" },
};

/** After `update(subscription, { scheduled_change: null })` — the withdrawal. Nothing is pending again. */
const WITHDRAWN = {
  ...RECORDED_IDENTITY,
  status: "active",
  scheduled_change: null,
  current_billing_period: { starts_at: "2026-08-15T11:42:21.789736Z", ends_at: "2026-09-15T11:42:21.789736Z" },
  items: [{ price_id: "pri_01kzvyz9khsdy36z10wb8bgmq4", quantity: 1 }],
};

describe("a previewed plan change parses as Paddle really sends one (#465)", () => {
  test("an upgrade is a charge, and the credit inside it is negative", () => {
    // Fact 1, at the field that establishes it. `credit.amount` is `"-380"`: a schema refusing negatives
    // would throw here, on the ordinary upgrade, at the instant a customer pressed the button.
    const preview = PaddleSubscriptionPreview.parse(PREVIEW_UPGRADE);
    expect(preview.update_summary?.result.action).toBe("charge");
    expect(minorAmount(preview.update_summary?.result.amount)).toBe(6582);
    expect(minorAmount(preview.update_summary?.credit?.amount)).toBe(-380);
    expect(minorAmount(preview.update_summary?.charge?.amount)).toBe(6962);
  });

  test("a downgrade's headline is the credit, and `grand_total` says nothing about it", () => {
    // Fact 2. `grand_total: "0"` is true and useless — the customer is owed 6581 and it is sitting in
    // `credit_to_balance`. A screen wired to the totals says "You will be charged $0.00" and never
    // mentions the money. `update_summary.result` is the sentence.
    const preview = PaddleSubscriptionPreview.parse(PREVIEW_DOWNGRADE);
    expect(preview.update_summary?.result).toEqual({ action: "credit", amount: "6581", currency_code: "USD" });

    const totals = preview.immediate_transaction?.details?.totals;
    expect(totals?.grand_total).toBe("0");
    expect(totals?.credit_to_balance).toBe("6581");
    // And the rest of the block is negative throughout, which is the same refutation as above with three
    // more fields behind it.
    expect(minorAmount(totals?.subtotal)).toBe(-6045);
    expect(minorAmount(totals?.tax)).toBe(-536);
    expect(minorAmount(totals?.total)).toBe(-6581);
  });

  test("nothing settles today: `immediate_transaction` is null and the preview is still a preview", () => {
    // Fact 5, and it is the adopter's own downgrade policy rather than an edge case: under
    // `prorated_next_billing_period` Paddle documents no immediate transaction, because there is no
    // charge today. The recurring block is the whole answer, and it must survive the absence.
    const preview = PaddleSubscriptionPreview.parse({ ...PREVIEW_DOWNGRADE, immediate_transaction: null });
    expect(preview.immediate_transaction).toBeNull();
    expect(preview.recurring_transaction_details?.totals?.grand_total).toBe("653");
    expect(preview.update_summary?.result.action).toBe("credit");
  });

  test("`fee` and `earnings` arrive null, `exchange_rate` arrives, and the shape carries all three", () => {
    // Fact 4. `.loose()` would pass an undeclared `exchange_rate` through regardless; declaring it is what
    // puts it in the type, and declaring `fee` is what stops a later reader treating null as absent.
    const totals = PaddleSubscriptionPreview.parse(PREVIEW_UPGRADE).immediate_transaction?.details?.totals;
    expect(totals?.fee).toBeNull();
    expect(totals?.earnings).toBeNull();
    expect(totals?.exchange_rate).toBe("1");
    expect(totals && "fee" in totals).toBe(true);
  });

  test("the immediate transaction's billing period is the period the change lands in", () => {
    const preview = PaddleSubscriptionPreview.parse(PREVIEW_UPGRADE);
    expect(preview.immediate_transaction?.billing_period?.starts_at).toBe("2026-08-28T11:13:32.939Z");
    // The same instant a cancellation on this subscription is scheduled for, in the recording below. The
    // prorated period ends where the paid period does, which is the cross-check that both were read off
    // one subscription rather than assembled.
    expect(preview.immediate_transaction?.billing_period?.ends_at).toBe(SCHEDULED_CANCEL.scheduled_change.effective_at);
  });
});

describe("a scheduled change, read once (#465)", () => {
  const OCCURRED = new Date("2026-08-28T11:13:32.939Z");

  test("a scheduled cancel is `active`, uncanceled, and has no next billing date", () => {
    // Fact 3, and the reason the normalizer exists. `next_billed_at` — the field a "Renews on" line reads
    // — is null on exactly the subscription whose end date the customer most needs to see, and `status`
    // still says `active` while it happens. The date is on the scheduled change and nowhere else.
    const subscription = PaddleSubscription.parse(SCHEDULED_CANCEL);
    expect(subscription.status).toBe("active");
    expect(subscription.canceled_at).toBeNull();
    expect(subscription.next_billed_at).toBeNull();
    expect(subscriptionPendingChange(subscription)).toEqual({
      action: "cancel",
      effectiveAt: "2026-09-15T11:42:21.789736Z",
      resumeAt: null,
    });
  });

  test("and nothing in the projected event distinguishes it from one that renews", () => {
    // The live defect, recorded rather than fixed here. Both rows project `active` with the same expiry,
    // so a consumer reading the event cannot tell "ends on the 15th" from "renews on the 15th". Changing
    // that is a change to what the projection carries, which belongs with the code that would read it.
    const ending = subscriptionEvent(PaddleSubscription.parse(SCHEDULED_CANCEL), OCCURRED, "sandbox");
    const renewing = subscriptionEvent(PaddleSubscription.parse(WITHDRAWN), OCCURRED, "sandbox");
    expect(ending.status).toBe(renewing.status);
    expect(ending.expiresAt).toEqual(renewing.expiresAt);
    // `subscriptionResumesAt` reads `effective_at` only on a `resume`, so the cancel's date is invisible
    // to it. Unchanged on purpose — other code depends on this answer.
    expect(subscriptionResumesAt(PaddleSubscription.parse(SCHEDULED_CANCEL))).toBeNull();
  });

  test("the withdrawal leaves nothing pending", () => {
    expect(subscriptionPendingChange(PaddleSubscription.parse(WITHDRAWN))).toBeNull();
  });

  test("pause and resume come through the same reader, and `subscriptionResumesAt` still answers as it did", () => {
    // One parse, two readers. The paused fixtures are the ones #369 recorded, and the resume date is still
    // the string the pause request sent — this step must not have moved it.
    const paused = PaddleSubscription.parse(PADDLE_PAUSED_WITH_RESUME_DATE);
    expect(subscriptionPendingChange(paused)).toEqual({
      action: "resume",
      effectiveAt: PADDLE_PAUSE_RESUME_AT,
      resumeAt: null,
    });
    expect(subscriptionResumesAt(paused)).toBe(PADDLE_PAUSE_RESUME_AT);

    const indefinite = PaddleSubscription.parse(PADDLE_PAUSED_INDEFINITELY);
    expect(subscriptionPendingChange(indefinite)).toBeNull();
    expect(subscriptionResumesAt(indefinite)).toBeNull();
  });

  test("`items` on a scheduled change is carried, null and all", () => {
    // Fact 6's fourth field. Paddle sends it; every recording so far sends it null. Declared so a later
    // reader finds it in the type rather than in a `.loose()` passthrough nobody wrote down.
    const parsed = PaddleSubscription.parse(SCHEDULED_CANCEL);
    expect(parsed.scheduled_change?.items).toBeNull();
  });

  test("an action this build does not map refuses rather than being read as one of the three", () => {
    // The rule `subscriptionStatus` already follows. A new Paddle action quietly normalized into `cancel`
    // is a wrong date, or a wrong sentence, in front of a paying customer.
    for (const action of ["renew", "", undefined]) {
      const subscription = PaddleSubscription.parse({
        ...SCHEDULED_CANCEL,
        scheduled_change: { action, effective_at: "2026-09-15T11:42:21.789736Z" },
      });
      expect(() => subscriptionPendingChange(subscription), String(action)).toThrow(PaymentsVerificationFailedError);
    }
  });
});

describe("what already parsed still parses (#465 regression guard)", () => {
  test("every Paddle entity in `fixtures/` still parses under its own shape", () => {
    // The guard the preview shapes are held to: they add schemas, they do not narrow the ones the rest of
    // this rail runs on. The sweep is over the directory rather than a list, so a fixture added later is
    // covered without anyone remembering to add it here — and the floor is what stops a sweep that matched
    // nothing reading as a pass. Two subscriptions today; `fixtures/` holds no transaction yet, which is
    // why the transaction is guarded directly in the test below.
    const glob = (
      import.meta as unknown as {
        glob(patterns: string[], options: { eager: true }): Record<string, Record<string, unknown>>;
      }
    ).glob(["./fixtures/*.ts"], { eager: true });

    let parsed = 0;
    for (const [path, module] of Object.entries(glob)) {
      for (const [name, value] of Object.entries(module)) {
        if (typeof value !== "object" || value === null) continue;
        const id = (value as { id?: unknown }).id;
        if (typeof id !== "string") continue;
        const where = `${path}#${name}`;
        if (id.startsWith("sub_")) expect(() => PaddleSubscription.parse(value), where).not.toThrow();
        else if (id.startsWith("txn_")) expect(() => PaddleTransaction.parse(value), where).not.toThrow();
        else continue;
        parsed += 1;
      }
    }
    expect(parsed).toBeGreaterThanOrEqual(2);
  });

  test("a transaction still parses, and its totals still tolerate everything a preview's do", () => {
    // `PaddleTransaction.details.totals` is deliberately not rebuilt on the preview's totals shape — see
    // the argument at `PaddleTotals`. This is the assertion that keeps that decision honest: the ordinary
    // money row still reads, and the transaction shape still accepts a totals block carrying signed
    // figures, a null `fee` and an `exchange_rate`, because it always did.
    const ordinary = PaddleTransaction.parse({
      id: "txn_01hv8wptq8987qeep44cyrewp9",
      status: "completed",
      subscription_id: "sub_01",
      items: [{ price: { id: "pri_01" } }],
      details: { totals: { grand_total: "9900", currency_code: "USD" } },
      created_at: "2026-08-12T09:00:00Z",
    });
    const event = transactionEvent(ordinary, new Date("2026-08-12T09:00:00Z"), "sandbox");
    expect(event.amountMinor).toBe(9900);
    expect(event.currency).toBe("usd");

    const refundish = PaddleTransaction.parse({
      id: "txn_01hv8wptq8987qeep44cyrewq0",
      status: "completed",
      items: [{ price_id: "pri_01" }],
      details: { totals: PREVIEW_DOWNGRADE.immediate_transaction.details.totals },
      created_at: "2026-08-12T09:00:00Z",
    });
    expect(refundish.details?.totals?.grand_total).toBe("0");
  });
});
