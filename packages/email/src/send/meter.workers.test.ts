// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import type { MeterCharge } from "@pithy-sh/core/src/entitlement/meter";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { defaultTheme } from "../templates/theme";
import { type EnqueueDeps, type EnqueueInput, enqueueEmail } from "./enqueue";
import { suppress } from "./suppression";

/**
 * The `emails` meter at enqueue (#561): charged before the row exists, so a refusal writes no job; charged
 * only for a message going somewhere, and only when the caller names who it is sent for.
 */

const ACME = { subjectType: "organization", subjectId: "acme" } as const;
const PAYLOAD = { inviterName: "Sam", organizationName: "Acme", acceptUrl: "https://acme.test/accept" };

let minted = 0;
function deps(overrides: Partial<EnqueueDeps> = {}): EnqueueDeps {
  minted += 1;
  const id = `job-${minted}`;
  return {
    db: emailDatabase(env.DB),
    fromAddress: "noreply@acme.test",
    fromName: "Acme",
    theme: defaultTheme,
    suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
    now: new Date("2026-06-18T12:00:00.000Z"),
    newId: () => id,
    ...overrides,
  };
}

const invite = (to: string, subject = true): EnqueueInput => ({
  to,
  template: "invite",
  payload: PAYLOAD,
  ...(subject ? { subject: ACME } : {}),
});

async function jobs(): Promise<number> {
  const row = await env.DB.prepare("select count(*) as n from pithy_email_jobs").first<{ n: number }>();
  return row?.n ?? 0;
}

/** A meter with a fixed allowance, recording each charge — the composed provider's shape. */
function allowance(limit: number) {
  const charges: MeterCharge[] = [];
  return {
    charges,
    meter: async (charge: MeterCharge) => {
      if (charges.length >= limit) {
        throw new PithyError({
          code: "payments/quota_exceeded",
          status: 402,
          message: "This plan's allowance is used up for this period.",
        });
      }
      charges.push(charge);
    },
  };
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("the emails meter at enqueue", () => {
  test("charges one email against the named subject, and queues it", async () => {
    const { charges, meter } = allowance(5);
    await enqueueEmail(deps({ meter }), invite("ada@example.test"));
    expect(charges).toEqual([{ subject: ACME, meter: "emails", amount: 1, now: new Date("2026-06-18T12:00:00.000Z") }]);
    expect(await jobs()).toBe(1);
  });

  test("past the quota the enqueue throws payments/quota_exceeded at 402 and writes no job row", async () => {
    const { meter } = allowance(1);
    await enqueueEmail(deps({ meter }), invite("ada@example.test"));
    const refused = enqueueEmail(deps({ meter }), invite("grace@example.test"));
    await expect(refused).rejects.toMatchObject({ payload: { code: "payments/quota_exceeded", status: 402 } });
    expect(await jobs()).toBe(1);
  });

  test("a message naming no subject is never counted — the kit's own mail is nobody's usage", async () => {
    const { charges, meter } = allowance(0);
    await enqueueEmail(deps({ meter }), invite("ada@example.test", false));
    expect(charges).toEqual([]);
    expect(await jobs()).toBe(1);
  });

  test("a withheld recipient costs nothing: the meter is charged only for a message going somewhere", async () => {
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "gone@example.test", reason: "hard_bounce" },
      new Date(),
    );
    const { charges, meter } = allowance(0);
    const result = await enqueueEmail(deps({ meter }), invite("gone@example.test"));
    expect(result.status).toBe("suppressed");
    expect(charges).toEqual([]);
  });

  test("with no provider composed there is no meter, and the enqueue is what it always was", async () => {
    await enqueueEmail(deps(), invite("ada@example.test"));
    expect(await jobs()).toBe(1);
  });
});
