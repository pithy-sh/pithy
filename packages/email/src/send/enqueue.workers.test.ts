// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { renderSubject } from "../templates/engine";
import { emailTranslator, kitEmailLayers } from "../templates/messages";
import { defaultTheme } from "../templates/theme";
import { type EnqueueDeps, type EnqueueInput, enqueueEmail, type SendWorkflowBinding } from "./enqueue";
import { suppress } from "./suppression";

/**
 * **The gate for pithy-sh/pithy#443: a caller can read what it just sent.**
 *
 * `enqueueEmail` renders the subject in the recipient's language and writes it to
 * `pithy_email_jobs.subject`. For as long as the result carried only the id and the status, the caller
 * that has to *record* what it queued could not read that sentence. The workaround was to render the
 * same key a second time — the adopter restating the theme it configured and the layer stack it
 * composed, and holding a test pinning its own copy against the kit's catalog. `pithy-sh/dashboard#89`
 * did exactly that on the invitation path.
 *
 * So every assertion here is the same shape, deliberately: **the returned subject is compared against
 * the stored one, read back out of D1.** Not against a literal — a literal would pass on the day the
 * result stopped following the row, which is the day this file exists for. The one literal in the file
 * is the anti-vacuity check below, and it is there to prove the comparison can fail.
 *
 * **What is pinned here is the enqueue-time render, which is all the field claims to be.** `runSend`
 * renders again at the moment the message leaves and rewrites the column from that, so a scheduled job
 * whose catalog moved in between delivers a sentence this value never held. That boundary is asserted
 * where both renders are in one place — `runSend.workers.test.ts`, "the delivered subject is the send's
 * own render, not the one enqueue answered with".
 *
 * **Every return path, because a suppressed send is the one that most needs auditing.** A blocked
 * recipient's row is born `suppressed` and still carries a rendered subject, and the caller writing an
 * audit trail for a message that reached nobody needs the sentence as much as any other. An
 * `undispatched` row is the same case for the same reason (pithy-sh/pithy#410): the deployment binds no
 * send Workflow, and the row is a real row all the same.
 *
 * **Not the body.** A body is large, it is the thing this capability is careful never to log, and no
 * caller has a reason to hold one. Nothing here asks for it.
 */

/** The three facts the kit's `invite` template takes. Transactional, so a hard bounce withholds it. */
const INVITE_PAYLOAD = { inviterName: "Sam", organizationName: "Acme", acceptUrl: "https://acme.test/accept" };

/** A send-Workflow binding that records rather than dispatches — enough to make a job `pending`. */
function recordingSender(): SendWorkflowBinding {
  return {
    async create() {
      return undefined;
    },
  };
}

let minted = 0;

/**
 * Enqueue deps over the live Miniflare databases, with a fresh job id per call.
 *
 * `layersFor` is left absent, so the kit's own catalogs answer — which is what a project that composed
 * no i18n capability walks, and what makes the Spanish assertion below a statement about this package
 * rather than about a composition.
 */
function deps(overrides: Partial<EnqueueDeps> = {}): EnqueueDeps {
  minted += 1;
  const id = `job-${minted}`;
  return {
    db: emailDatabase(env.DB),
    fromAddress: "noreply@acme.test",
    fromName: "Acme",
    theme: defaultTheme,
    now: new Date("2026-06-18T12:00:00.000Z"),
    newId: () => id,
    ...overrides,
  };
}

/** An invitation to one address, in one language. */
function invite(to: string, locale?: string): EnqueueInput {
  return { to, template: "invite", payload: INVITE_PAYLOAD, ...(locale === undefined ? {} : { locale }) };
}

/** The subject the row carries, read straight out of D1 — the authority the result has to match. */
async function storedSubject(jobId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("select subject from pithy_email_jobs where id = ?")
    .bind(jobId)
    .first<{ subject: string }>();
  return row?.subject;
}

/** Provision both databases: the app DB the jobs live in, and the shared suppression list. */
async function migrate(): Promise<void> {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
}

beforeEach(migrate);

describe("an enqueue answers with the subject it wrote", () => {
  test("a queued send: the result carries the row's own sentence", async () => {
    const result = await enqueueEmail(deps({ sender: recordingSender() }), invite("fresh@example.test"));

    expect(result.status).toBe("pending");
    expect(result.subject).toBe(await storedSubject(result.jobId));
  });

  test("a suppressed send: nothing left, and the caller can still audit what did not", async () => {
    await suppress(
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      { email: "bounced@example.test", reason: "hard_bounce" },
      new Date(),
    );
    const result = await enqueueEmail(
      deps({ sender: recordingSender(), suppressionDb: emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS) }),
      invite("bounced@example.test"),
    );

    expect(result.status).toBe("suppressed");
    expect(result.suppressionReason).toBe("hard_bounce");
    expect(result.subject).toBe(await storedSubject(result.jobId));
  });

  test("a send with nothing to dispatch it on: a real row, and a real subject", async () => {
    const result = await enqueueEmail(deps(), invite("fresh@example.test"));

    expect(result.status).toBe("undispatched");
    expect(result.subject).toBe(await storedSubject(result.jobId));
  });

  test("a scheduled send, which no Workflow is started for either", async () => {
    const result = await enqueueEmail(deps({ sender: recordingSender() }), {
      ...invite("fresh@example.test"),
      mode: "scheduled",
      sendAt: new Date("2026-06-19T09:00:00.000Z"),
    });

    expect(result.status).toBe("scheduled");
    expect(result.subject).toBe(await storedSubject(result.jobId));
  });
});

describe("and it is the recipient's language, never the kit's English by default", () => {
  test("an invitation enqueued at `es` comes back in Spanish, matching its row", async () => {
    const result = await enqueueEmail(deps({ sender: recordingSender() }), invite("fresh@example.test", "es"));

    expect(result.subject).toBe(await storedSubject(result.jobId));
    // Rendered through the same key, the same registry and the same catalogs the enqueue walked —
    // which is what the adopter was doing by hand, and what it no longer has to do.
    expect(result.subject).toBe(
      renderSubject("invite", INVITE_PAYLOAD, defaultTheme, emailTranslator("es", kitEmailLayers)),
    );
  });

  /**
   * **Anti-vacuity, and the whole reason the field is not cosmetic.**
   *
   * The dashboard's audit row matched the delivered subject by coincidence for as long as there was one
   * language: its own wording happened to be the kit's English, word for word. Pass a locale and the two
   * diverge silently — an audit row claiming a sentence nobody was ever sent. The two strings below have
   * to differ, or every comparison above would hold no matter which language the row was written in.
   */
  test("the two languages differ, so matching the row is a real claim", async () => {
    const english = await enqueueEmail(deps({ sender: recordingSender() }), invite("fresh@example.test"));
    const spanish = await enqueueEmail(deps({ sender: recordingSender() }), invite("fresh@example.test", "es"));

    expect(english.subject).toBe("Sam invited you to Acme");
    expect(spanish.subject).toBe("Sam te ha invitado a Acme");
  });
});
