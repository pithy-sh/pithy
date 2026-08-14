// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { type EmailEnqueueEnv, email } from "../capability";
import { EmailKind, type SuppressionReason as Reason, SuppressionReason } from "../data/enums";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { templateKind } from "../templates/engine";
import type { SendWorkflowBinding } from "./enqueue";
import { suppress } from "./suppression";

/**
 * **The gate for pithy-sh/pithy#355: an adopter gets suppression without declaring anything.**
 *
 * The rule this file holds, in the words it was given: *suppressions are supposed to be automatic, the
 * user's code should not need to directly access the suppressions* — and *the wiring is not the
 * adopter's problem*. So everything below composes the capability the way `pithy.config.ts` does, hands
 * it the worker `env` unopened, and never writes the string `EMAIL_SUPPRESSIONS` anywhere on the
 * adopter's side of the seam. Restore the requirement to name a binding and every test here goes red,
 * which is the only reason the file exists as a separate one.
 *
 * The one place a binding name is written is {@link migrate}, and it is not the adopter's side: that is
 * `wrangler.jsonc` and `pithy migrate` provisioning a database, which nobody claims is invisible. The
 * claim is narrower and it is the whole claim — **composing email and sending mail costs an adopter no
 * declaration about suppression.**
 *
 * ## And the distinction that has to survive it
 *
 * `pithy-sh/dashboard#26` established that suppression is asked of the **template's own kind**, never a
 * restated `"transactional"`. An automatic check that treated every send alike would start silently
 * dropping invitations to people who unsubscribed from a newsletter — which is the exact failure this
 * capability's `suppressionBlocks` exists to prevent, and the exact failure making the check automatic
 * could have reintroduced. The frozen table below is the assertion that it did not.
 */

/** The composed capability, exactly as `pithy.config.ts` writes it. No binding is named here. */
function composedEmail() {
  return email({ fromAddress: "noreply@acme.test", fromName: "Acme", baseUrl: "https://acme.test" });
}

/** A send-Workflow binding that records rather than dispatches — "was this address mailed at all". */
function recordingSender(): { binding: SendWorkflowBinding; dispatched: string[][] } {
  const dispatched: string[][] = [];
  return {
    dispatched,
    binding: {
      async create(options) {
        dispatched.push(options.params.jobIds);
        return undefined;
      },
    },
  };
}

/**
 * The adopter's worker env, forwarded whole.
 *
 * This is the shape of the claim: a consumer spreads its own `env` and adds nothing about suppression,
 * because it does not know and must not need to know which binding the list lives behind. `EMAIL_SENDER`
 * is substituted because Miniflare has no Workflows to bind, not because an adopter would name it —
 * `enqueue` reads it off the env in production exactly as it reads the suppression database.
 */
function adopterEnv(sender: SendWorkflowBinding): EmailEnqueueEnv {
  return { ...(env as unknown as Record<string, unknown>), EMAIL_SENDER: sender } as unknown as EmailEnqueueEnv;
}

/** Provision both databases. The `wrangler.jsonc` half of the world, not the adopter-code half. */
async function migrate(): Promise<void> {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
}

/** Put an address on the list, as a bounce or an operator would. The *operator's* side may name it. */
async function block(address: string, reason: Reason): Promise<void> {
  await suppress(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS), { email: address, reason }, new Date());
}

/** The stored status of a job, read straight out of D1. */
async function jobStatus(jobId: string): Promise<string | undefined> {
  const row = await env.DB.prepare("select status from pithy_email_jobs where id = ?")
    .bind(jobId)
    .first<{ status: string }>();
  return row?.status;
}

/**
 * Whether a live suppression for this reason withholds a message of this kind. **Frozen, and written
 * out rather than derived** — a table computed from `suppressionBlocks` would agree with whatever that
 * function does next, including the thing this file exists to forbid.
 *
 * Seven cells block; exactly one sends. That one cell is the invitation.
 */
const BLOCKS: Readonly<Record<Reason, Readonly<Record<EmailKind, boolean>>>> = Object.freeze({
  hard_bounce: Object.freeze({ transactional: true, elective: true }),
  complaint: Object.freeze({ transactional: true, elective: true }),
  unsubscribe: Object.freeze({ transactional: false, elective: true }),
  manual: Object.freeze({ transactional: true, elective: true }),
});

/** A real registered template declaring each kind. Checked against the registry below, never assumed. */
const TEMPLATE_OF_KIND: Readonly<Record<EmailKind, string>> = Object.freeze({
  transactional: "invite",
  elective: "testerNudge",
});

/** A valid payload per template above. */
const PAYLOAD_OF_KIND: Readonly<Record<EmailKind, Record<string, unknown>>> = Object.freeze({
  transactional: { inviterName: "Sam", organizationName: "Acme", acceptUrl: "https://acme.test/accept" },
  elective: { subject: "Still with us?", heading: "Still with us?", paragraphs: ["One line."] },
});

/**
 * The frozen answer for one cell. **An unnameable case throws** rather than defaulting: a reason or a
 * kind this table has never heard of is a change to the vocabulary, and a gate that quietly returned
 * `true` for it would pass on the day it matters most.
 */
function frozenAnswer(reason: Reason, kind: EmailKind): boolean {
  const row = BLOCKS[reason];
  if (row === undefined) throw new Error(`no frozen expectation for suppression reason '${reason}'`);
  const answer = row[kind];
  if (answer === undefined) throw new Error(`no frozen expectation for kind '${kind}' under reason '${reason}'`);
  return answer;
}

beforeEach(migrate);

describe("the frozen table is the vocabulary, exactly", () => {
  test("it names every suppression reason and every kind the schemas declare", () => {
    expect(Object.keys(BLOCKS).sort()).toEqual([...SuppressionReason.options].sort());
    expect(Object.keys(TEMPLATE_OF_KIND).sort()).toEqual([...EmailKind.options].sort());
    expect(Object.keys(PAYLOAD_OF_KIND).sort()).toEqual([...EmailKind.options].sort());
  });

  test("each named template really declares the kind it is filed under", () => {
    for (const kind of EmailKind.options) {
      expect(templateKind(TEMPLATE_OF_KIND[kind]), TEMPLATE_OF_KIND[kind]).toBe(kind);
    }
  });

  test("it is not vacuous: seven cells withhold and exactly one sends", () => {
    const cells = Object.values(BLOCKS).flatMap((row) => Object.values(row));
    expect(cells.length).toBe(8);
    expect(cells.filter((cell) => cell === true).length).toBe(7);
    expect(cells.filter((cell) => cell === false).length).toBe(1);
    expect(frozenAnswer("unsubscribe", "transactional")).toBe(false);
  });
});

describe("an adopter who declares nothing still gets suppression", () => {
  test("a hard-bounced address is not mailed, and nothing named a binding to say so", async () => {
    await block("bounced@example.test", "hard_bounce");
    const sender = recordingSender();
    const result = await composedEmail().enqueue(adopterEnv(sender.binding), {
      to: "bounced@example.test",
      template: "invite",
      payload: PAYLOAD_OF_KIND.transactional,
    });

    expect(result.status).toBe("suppressed");
    expect(result.suppressionReason).toBe("hard_bounce");
    expect(await jobStatus(result.jobId)).toBe("suppressed");
    // The whole of "not mailed": no send Workflow was ever started for it.
    expect(sender.dispatched).toEqual([]);
  });

  test("anti-vacuity: the same composition mails an address that is not on the list", async () => {
    const sender = recordingSender();
    const result = await composedEmail().enqueue(adopterEnv(sender.binding), {
      to: "fresh@example.test",
      template: "invite",
      payload: PAYLOAD_OF_KIND.transactional,
    });

    expect(result.status).toBe("pending");
    expect(result.suppressionReason).toBeUndefined();
    expect(await jobStatus(result.jobId)).toBe("pending");
    expect(sender.dispatched).toEqual([[result.jobId]]);
  });

  test("the skip is on the record as an event, not swallowed", async () => {
    await block("complained@example.test", "complaint");
    const result = await composedEmail().enqueue(adopterEnv(recordingSender().binding), {
      to: "complained@example.test",
      template: "invite",
      payload: PAYLOAD_OF_KIND.transactional,
    });
    const row = await env.DB.prepare("select type, detail from pithy_email_events where job_id = ?")
      .bind(result.jobId)
      .first<{ type: string; detail: string }>();
    expect(row).toEqual({ type: "suppressed", detail: "complaint" });
  });
});

describe("the automatic check asks the template's own kind", () => {
  test("an unsubscribe does not withhold an invitation", async () => {
    await block("optedout@example.test", "unsubscribe");
    const sender = recordingSender();
    const result = await composedEmail().enqueue(adopterEnv(sender.binding), {
      to: "optedout@example.test",
      template: TEMPLATE_OF_KIND.transactional,
      payload: PAYLOAD_OF_KIND.transactional,
    });

    expect(result.status).toBe("pending");
    expect(sender.dispatched).toEqual([[result.jobId]]);
  });

  test("the same unsubscribe does withhold the elective mail it was about", async () => {
    await block("optedout@example.test", "unsubscribe");
    const sender = recordingSender();
    const result = await composedEmail().enqueue(adopterEnv(sender.binding), {
      to: "optedout@example.test",
      template: TEMPLATE_OF_KIND.elective,
      payload: PAYLOAD_OF_KIND.elective,
    });

    expect(result.status).toBe("suppressed");
    expect(result.suppressionReason).toBe("unsubscribe");
    expect(sender.dispatched).toEqual([]);
  });

  test("every reason against every kind, end to end, against the frozen table", async () => {
    for (const reason of SuppressionReason.options) {
      for (const kind of EmailKind.options) {
        await migrate();
        const address = `${reason}-${kind}@example.test`;
        await block(address, reason);
        const sender = recordingSender();
        const result = await composedEmail().enqueue(adopterEnv(sender.binding), {
          to: address,
          template: TEMPLATE_OF_KIND[kind],
          payload: PAYLOAD_OF_KIND[kind],
        });
        const label = `${reason} / ${kind}`;
        if (frozenAnswer(reason, kind)) {
          expect(result.status, label).toBe("suppressed");
          expect(result.suppressionReason, label).toBe(reason);
          expect(sender.dispatched, label).toEqual([]);
        } else {
          expect(result.status, label).toBe("pending");
          expect(result.suppressionReason, label).toBeUndefined();
          expect(sender.dispatched, label).toEqual([[result.jobId]]);
        }
      }
    }
  });
});

describe("it is their database, and reading it is ordinary", () => {
  test("the capability hands back the suppression list from the env, naming no binding", async () => {
    await block("bounced@example.test", "hard_bounce");
    const db = composedEmail().suppressions(adopterEnv(recordingSender().binding));
    const row = await db
      .selectFrom("pithyEmailSuppressions")
      .select(["email", "reason"])
      .where("email", "=", "bounced@example.test")
      .executeTakeFirst();
    expect(row).toEqual({ email: "bounced@example.test", reason: "hard_bounce" });
  });

  test("writing to it is ordinary too — an operator lifts a suppression and the mail goes", async () => {
    await block("fixed@example.test", "hard_bounce");
    const capability = composedEmail();
    const sender = recordingSender();
    const db = capability.suppressions(adopterEnv(sender.binding));
    await db.deleteFrom("pithyEmailSuppressions").where("email", "=", "fixed@example.test").execute();

    const result = await capability.enqueue(adopterEnv(sender.binding), {
      to: "fixed@example.test",
      template: "invite",
      payload: PAYLOAD_OF_KIND.transactional,
    });
    expect(result.status).toBe("pending");
    expect(sender.dispatched).toEqual([[result.jobId]]);
  });

  test("asking for a list this env does not carry is a named wiring fault, never an empty list", () => {
    expect(() => composedEmail().suppressions({ DB: env.DB } as unknown as EmailEnqueueEnv)).toThrowError();
  });
});
