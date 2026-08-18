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
  PADDLE_CUSTOM_ACCOUNT,
  PADDLE_CUSTOM_ENV,
  PADDLE_CUSTOM_PROOF,
  PaddleSubscription,
  subscriptionEvent,
  subscriptionResumesAt,
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

      // And with the one value they could not produce, the identical object is honoured. So the field
      // that decides is the proof, and every other field in these fixtures is already right.
      //
      // The owner the fixtures carry is a bare id — they were recorded before subjects existed, and a
      // browser writes whatever it likes anyway — so the honoured form encodes it. That is the shape our
      // own checkout stamps, and the only shape the reader honours.
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
