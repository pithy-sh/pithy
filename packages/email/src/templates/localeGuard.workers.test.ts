// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { emailDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { enqueueEmail } from "../send/enqueue";
import { renderEmail } from "./engine";
import { emailTranslator, kitEmailLayers } from "./messages";
import { defaultTheme } from "./theme";

/**
 * Six tags that look like language tags and are not.
 *
 * Each one matches `LANGUAGE_TAG` — the shape check in `@pithy-sh/core`'s `locale.ts` — and each one
 * raises `RangeError` in `new Intl.Locale()` and therefore in `Intl.PluralRules`. A singleton subtag
 * with nothing after it (`en-x`, `en-t`, `en-u`, `en-US-x`), a numeric singleton (`en-1`), and a
 * repeated extension (`en-a-bbb-a-ccc`) are shapes a regular expression cannot see.
 */
const REFUSED_BY_ICU = ["en-x", "en-t", "en-u", "en-1", "en-US-x", "en-a-bbb-a-ccc"] as const;

/** An OTP payload. `otp` and `magicLink` are the two kit templates whose body renders `{{tn}}`. */
const OTP_PAYLOAD = { code: "123456", expiresMinutes: 15 };

/**
 * A locale `Intl` refuses must never reach `Intl`.
 *
 * **In the Workers runtime, because workerd's ICU is the one that throws.** The whole failure this
 * guards lives inside the send Workflow — a Worker with no request on it, where a raw `RangeError` is
 * not a `PithyError`, `classifySendError` sees no code it knows, and the job burns its retries and
 * wedges. Asserting it in Node would be asserting it somewhere the failure does not happen.
 *
 * **Two repairs, one belt and one braces, and this file exercises both.**
 *
 * `@pithy-sh/core`'s `Locale` refines through `parseLocale`, so none of these six can be written to
 * `pithy_email_jobs.locale` or read back out of it — that is the outer repair, and the second test
 * here is what says so. The inner one is `emailTranslator`, which takes a bare `string` from two
 * callers: `enqueueEmail`, which renders the subject *before* anything has validated its input, and
 * `runSend`, which renders a row that an adopter's own SQL or a build predating that refinement could
 * have written. Falling back costs a message in the wrong language. Not falling back costs the message.
 */
describe("a locale Intl refuses", () => {
  for (const tag of REFUSED_BY_ICU) {
    test(`\`${tag}\` renders in the kit's English rather than throwing`, async () => {
      const rendered = await renderEmail(
        "otp",
        OTP_PAYLOAD,
        defaultTheme,
        undefined,
        emailTranslator(tag, kitEmailLayers),
      );
      // The plural form resolved, which is the call that raises `RangeError` on an unguarded tag.
      expect(rendered.text).toContain("Your verification code is 123456. It expires in 15 minutes.");
      // And the document says what it is actually written in, rather than naming a locale nothing has.
      expect(rendered.html).toContain('lang="en"');
    });
  }

  /**
   * **And it never reaches the column — the tag is dropped, and the mail still goes.**
   *
   * This asserted `rejects.toThrow()` at first, on the reasoning that a column guarded by `Locale`
   * should refuse what it cannot hold. The column does refuse it; the question is what `enqueueEmail`
   * does about that, and throwing was the wrong answer for one concrete reason.
   *
   * `EmailJob.encode` raises a bare `ZodError`, which is not a `PithyError`, so the caller sees
   * `core/internal` — a 500 with nothing an operator can act on. And `en_US` is not a hypothetical
   * shape: it is exactly what Android, iOS and Java `Locale.toString()` produce, so a mobile client
   * reporting its own locale sends one. Through `@pithy-sh/support` that reached the reply path off a
   * stored submission context, and every operator reply on that thread failed, repeatably.
   *
   * **A locale is a rendering preference, and delivery beats fidelity.** Falling back costs a message
   * in the wrong language. Refusing costs the message — a magic link not sent because a tag had an
   * underscore in it. The docblock at the head of this file already argued that; the assertion did
   * not, and the assertion was what shipped.
   *
   * The boundary is still where validation belongs, and it is there:
   * `SupportSubmissionContext.locale` is a `Locale`, so the reporter's tag is now refused at the HTTP
   * edge with a `validation/invalid_input` 400 that names the field. This is the second line, for
   * every caller that is not the kit — and for rows written before either repair existed.
   */
  test("and it never reaches the column — the tag is dropped, and the mail still goes", async () => {
    await env.DB.prepare("drop table if exists pithy_email_jobs").run();
    await env.DB.prepare("drop table if exists pithy_email_events").run();
    await email_0001_init.up(emailDatabase(env.DB));

    // `en_US` and `pt_BR` are the platform shapes; the six above are the ones ICU refuses on subtags.
    for (const locale of [...REFUSED_BY_ICU, "en_US", "pt_BR", "not a locale", "C", "*"]) {
      const result = await enqueueEmail(
        {
          db: emailDatabase(env.DB),
          fromAddress: "noreply@pithy.sh",
          fromName: "Acme",
          theme: defaultTheme,
          now: new Date("2026-06-18T12:00:00.000Z"),
          newId: () => `job-${locale}`,
        },
        { to: "u@example.com", template: "otp", payload: OTP_PAYLOAD, locale },
      );
      // The row was written and nothing threw. (`undispatched` rather than `queued` because these
      // deps bind no sender — what matters here is that a job exists at all.)
      expect(result.jobId, locale).toBe(`job-${locale}`);
      const row = await env.DB.prepare("select locale from pithy_email_jobs where id = ?")
        .bind(`job-${locale}`)
        .first<{ locale: string | null }>();
      expect(row?.locale, locale).toBeNull();
    }
  });

  test("a tag Intl does take is kept whole, region and all", async () => {
    await env.DB.prepare("drop table if exists pithy_email_jobs").run();
    await env.DB.prepare("drop table if exists pithy_email_events").run();
    await email_0001_init.up(emailDatabase(env.DB));

    for (const locale of ["es", "es-AR", "zh-Hant-TW"]) {
      await enqueueEmail(
        {
          db: emailDatabase(env.DB),
          fromAddress: "noreply@pithy.sh",
          fromName: "Acme",
          theme: defaultTheme,
          now: new Date("2026-06-18T12:00:00.000Z"),
          newId: () => `kept-${locale}`,
        },
        { to: "u@example.com", template: "otp", payload: OTP_PAYLOAD, locale },
      );
      const row = await env.DB.prepare("select locale from pithy_email_jobs where id = ?")
        .bind(`kept-${locale}`)
        .first<{ locale: string | null }>();
      expect(row?.locale, locale).toBe(locale);
    }
  });
});
