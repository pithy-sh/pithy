// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import {
  type EmailRoutingRule,
  listEmailRoutingRules,
  namedRules,
} from "@pithy-sh/cloudflare/src/test-utils/emailRoutingRules";
import { fixtureReady, fixtureValue } from "@pithy-sh/cloudflare/src/test-utils/fixtures";
import { loadIntegrationCreds, uniqueName, withNamedResource } from "@pithy-sh/cloudflare/src/test-utils/harness";
import {
  deployInboundRecorder,
  INBOUND_NONCE_HEADER,
  PLACEHOLDER_INBOUND_MODULE,
  readObservedInbound,
  uploadModuleWorker,
} from "@pithy-sh/cloudflare/src/test-utils/inboundRecorder";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

/**
 * LIVE — the inbound half of `@pithy-sh/email`, against a real Cloudflare zone (#47).
 *
 * ## What this proves, and what it deliberately cannot
 *
 * **There is no inbox.** The fixture zone's only standing rule is a catch-all whose action is `drop`,
 * and the account has zero verified destination addresses. So nothing here can assert that mail was
 * *delivered to a mailbox*, and a test that waited for one would wait forever. The Worker is the
 * destination, so the Worker is what gets asserted on: a rule is created, and a real message posted to
 * the routed address arrives at a real Worker's `email()` handler, which records what it was handed.
 *
 * That is the seam `@pithy-sh/email` actually owns. Everything the capability *does* with an inbound
 * message — classify, suppress, mark the job — is exercised against real D1 in
 * `handler.workers.test.ts`, where a hostile message can be constructed exactly instead of mailed and
 * hoped for. Only one question needs a live delivery: **what does Cloudflare hand the handler?**
 *
 * ## Two things it does not attempt, and why
 *
 * **The bounce round trip.** Producing a real DSN means sending to an address that rejects, and having
 * the DSN routed back — which needs a verified destination or a second routed domain the account does
 * not have. #47's end-to-end box stays open, and the classifier is covered by unit tests over real DSN
 * text instead.
 *
 * **A forged `Authentication-Results`.** The only sender available is Cloudflare's own Email Sending
 * API, and it refuses to set that header (`10202`), refuses `Received`, and rejects a CRLF smuggled
 * into a custom header value. So the question "does a *sender's* forged verdict survive delivery?"
 * cannot be asked from here. What can be asked, and is: does an arbitrary sender-supplied header
 * survive, and does Cloudflare stamp its own verdict above it? Both answers together give the rule a
 * consumer needs — read the topmost instance, treat everything below it as the sender's.
 *
 * ## Everything it creates, it reaps
 *
 * Rules, Worker scripts and the KV namespace are all minted through `uniqueName`, so they sit inside the
 * `pithy-int-` reservation and the run's own sweep reclaims anything an abort leaves behind. The rule
 * teardown is armed **before** the rule is created (`withNamedResource`), because a create that fails on
 * the way back can still have been accepted — and a routing rule left behind is the one piece of debris
 * in this repository that changes what happens to somebody's mail.
 */

const creds = loadIntegrationCreds();
const routingReady = fixtureReady("cloudflare-account") && fixtureReady("email-routing");
const deliveryReady = routingReady && fixtureReady("email-sending");

/** The zone under test, and the domain its addresses are minted on. Read only when the fixture is ready. */
const zoneId = routingReady ? fixtureValue("email-routing", "EMAIL_ROUTING_ZONE_ID") : "";
const routedDomain = routingReady
  ? (fixtureValue("email-routing", "EMAIL_ROUTING_ADDRESS").split("@").at(-1) ?? "")
  : "";
const sendFrom = deliveryReady ? fixtureValue("email-sending", "EMAIL_SENDING_FROM") : "";

/** How long to wait for one delivery before sending again, and how many times to send at all. */
const POLL_INTERVAL_MS = 3000;
const POLL_ATTEMPTS = 15;
const SEND_ATTEMPTS = 2;

const clients = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });

/** An address on the routed domain, unique to this run so two runs cannot claim the same mailbox. */
function routedAddress(label: string): { address: string; localPart: string } {
  const localPart = uniqueName(label);
  return { address: `${localPart}@${routedDomain}`, localPart };
}

/** Cloudflare's send response — validated, because a response read is a boundary like any other. */
const SendResponse = z
  .object({
    success: z.boolean().describe("Cloudflare's verdict on the send."),
    errors: z
      .array(z.object({ code: z.number().describe("The error code."), message: z.string().describe("The text.") }))
      .default([])
      .describe("Why the send was refused, when it was."),
  })
  .describe("The Email Sending API's answer to one message.");

/** Post one message to the routed address, stamped with the nonce its record will be filed under. */
async function sendProbe(address: string, nonce: string): Promise<void> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/email/sending/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      to: address,
      from: { address: sendFrom, name: "Pithy" },
      subject: "Pithy inbound routing check",
      text: "A live check that inbound Email Routing reaches a Worker's email() handler.",
      headers: { [INBOUND_NONCE_HEADER]: nonce },
    }),
  });
  const body = SendResponse.parse(await response.json());
  // A refusal here is a token scope, not a flake: the endpoint answers 10000 without Email Sending: Edit.
  expect(body.errors).toEqual([]);
  expect(body.success).toBe(true);
}

/** The rule with this name on the zone, or undefined. */
async function ruleNamed(name: string): Promise<EmailRoutingRule | undefined> {
  return (await listEmailRoutingRules(creds, zoneId)).find((rule) => rule.name === name);
}

describe.skipIf(!routingReady)("Email Routing rules — LIVE", () => {
  const worker = uniqueName("inbound");
  const sibling = uniqueName("inbound-alt");

  beforeAll(async () => {
    // Cloudflare refuses a rule whose target script does not exist (`2016 Workers Script Info not
    // found`), so the Worker has to be real before the rule can be. A placeholder script is enough:
    // these tests are about the rule, not about what the Worker does with the mail.
    await uploadModuleWorker({ creds, scriptName: worker, module: PLACEHOLDER_INBOUND_MODULE });
    await uploadModuleWorker({ creds, scriptName: sibling, module: PLACEHOLDER_INBOUND_MODULE });
  }, 120_000);

  afterAll(async () => {
    await clients.workers().deleteWorker(worker);
    await clients.workers().deleteWorker(sibling);
  }, 120_000);

  test("creates the rule, and the zone stores the shape the manager sent", async () => {
    const { address } = routedAddress("rule");
    const ruleName = uniqueName("bounce-rule");

    await withNamedResource(
      ruleName,
      (name) => clients.emailRouting().ensureWorkerRoute({ zoneId, address, workerName: worker, ruleName: name }),
      async (name) => {
        const stored = await ruleNamed(name);
        // Read back from the zone, never from the request we just made: #47's open question is whether
        // the shape `ensureWorkerRoute` posts still matches the live API, and asserting on our own
        // argument answers that with our own opinion.
        expect(stored?.enabled).toBe(true);
        expect(stored?.matchers).toEqual([{ type: "literal", field: "to", value: address }]);
        expect(stored?.actions).toEqual([{ type: "worker", value: [worker] }]);
      },
      (name) =>
        clients
          .emailRouting()
          .removeWorkerRoute({ zoneId, ruleName: name })
          .then(() => undefined),
    );
  });

  test("a zone carries an unnamed catch-all whether or not anything is configured", async () => {
    // The trap #47 recorded: a rule count of 1 is not an empty zone. Every zone has this, and its
    // `enabled` flag — not the misleading `status` field — is what says routing is on.
    const rules = await listEmailRoutingRules(creds, zoneId);
    const catchAll = rules.find((rule) => rule.name === "");
    expect(catchAll?.matchers).toEqual([{ type: "all" }]);
    expect(catchAll?.enabled).toBe(true);
  });

  test("a second provision reuses the rule instead of duplicating it", async () => {
    const { address } = routedAddress("idem");
    const ruleName = uniqueName("bounce-idem");

    await withNamedResource(
      ruleName,
      (name) => clients.emailRouting().ensureWorkerRoute({ zoneId, address, workerName: worker, ruleName: name }),
      async (name) => {
        const second = await clients
          .emailRouting()
          .ensureWorkerRoute({ zoneId, address, workerName: worker, ruleName: name });
        expect(second).toEqual({ created: false });

        const mine = (await listEmailRoutingRules(creds, zoneId)).filter((rule) => rule.name === name);
        expect(mine).toHaveLength(1);
      },
      (name) =>
        clients
          .emailRouting()
          .removeWorkerRoute({ zoneId, ruleName: name })
          .then(() => undefined),
    );
  });

  test("two rules on one zone deliver to two different Workers", async () => {
    // The README says "one Worker per domain" while `ensureWorkerRoute` takes a Worker per rule. #95's
    // multi-project topology turns on which is true, so it is settled here rather than argued.
    const first = routedAddress("sib-a");
    const second = routedAddress("sib-b");
    const firstRule = uniqueName("bounce-sib-a");
    const secondRule = uniqueName("bounce-sib-b");

    await withNamedResource(
      firstRule,
      (name) =>
        clients
          .emailRouting()
          .ensureWorkerRoute({ zoneId, address: first.address, workerName: worker, ruleName: name }),
      async (nameA) => {
        await withNamedResource(
          secondRule,
          (name) =>
            clients
              .emailRouting()
              .ensureWorkerRoute({ zoneId, address: second.address, workerName: sibling, ruleName: name }),
          async (nameB) => {
            const rules = namedRules(await listEmailRoutingRules(creds, zoneId));
            const a = rules.find((rule) => rule.name === nameA);
            const b = rules.find((rule) => rule.name === nameB);
            expect(a?.actions).toEqual([{ type: "worker", value: [worker] }]);
            expect(b?.actions).toEqual([{ type: "worker", value: [sibling] }]);
          },
          (name) =>
            clients
              .emailRouting()
              .removeWorkerRoute({ zoneId, ruleName: name })
              .then(() => undefined),
        );
      },
      (name) =>
        clients
          .emailRouting()
          .removeWorkerRoute({ zoneId, ruleName: name })
          .then(() => undefined),
    );
  });

  test("removing the rule stops the delivery, and removing it again is a no-op", async () => {
    const { address } = routedAddress("remove");
    const ruleName = uniqueName("bounce-remove");

    await clients.emailRouting().ensureWorkerRoute({ zoneId, address, workerName: worker, ruleName });
    expect(await clients.emailRouting().removeWorkerRoute({ zoneId, ruleName })).toEqual({ removed: true });
    // Idempotent, which is what lets a teardown run twice and a reaper race another runner safely.
    expect(await clients.emailRouting().removeWorkerRoute({ zoneId, ruleName })).toEqual({ removed: false });
    expect(await ruleNamed(ruleName)).toBeUndefined();
  });

  test("a zone that does not exist fails as a PithyError, not as a raw Cloudflare throw", async () => {
    const { address } = routedAddress("nozone");
    const failure = await clients
      .emailRouting()
      .ensureWorkerRoute({
        zoneId: "00000000000000000000000000000000",
        address,
        workerName: worker,
        ruleName: uniqueName("bounce-nozone"),
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    // The public half stays client-safe; the status and the zone belong to `detail`, which never
    // reaches a browser.
    expect((failure as PithyError).payload.status).toBe(502);
  });

  test("a rule aimed at a Worker that does not exist fails, and leaves no rule behind", async () => {
    const { address } = routedAddress("noworker");
    const ruleName = uniqueName("bounce-noworker");

    const failure = await clients
      .emailRouting()
      .ensureWorkerRoute({ zoneId, address, workerName: `${worker}-absent`, ruleName })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PithyError);
    // The half that matters: a refused create must not leave a half-made rule claiming an address.
    expect(await ruleNamed(ruleName)).toBeUndefined();
  });
});

describe.skipIf(!deliveryReady)("An inbound message reaches the Worker's email() handler — LIVE", () => {
  const recorder = uniqueName("recorder");
  const namespaceTitle = uniqueName("inbound-kv");
  let namespaceId = "";

  beforeAll(async () => {
    // The Worker is the destination and the witness: it writes what it was handed to KV, and this
    // suite reads it back. There is no mailbox to read instead.
    namespaceId = (await clients.kvProvisioner().createNamespace(namespaceTitle)).id;
    await deployInboundRecorder({ creds, scriptName: recorder, namespaceId });
  }, 120_000);

  afterAll(async () => {
    // Both, whatever either does. An earlier version awaited them in sequence, and two runs that failed
    // to deploy the recorder left their KV namespace behind because the Worker delete threw first —
    // debris produced by the teardown's own ordering.
    const outcomes = await Promise.allSettled([
      clients.workers().deleteWorker(recorder),
      namespaceId ? clients.kvProvisioner().deleteNamespace(namespaceId) : Promise.resolve(),
    ]);
    const failed = outcomes.filter((outcome) => outcome.status === "rejected");
    if (failed.length > 0) console.warn(`${failed.length} teardown step(s) failed; the run's sweep will reclaim them.`);
  }, 120_000);

  test("Cloudflare hands the handler the message, its own verdict, and the sender's headers intact", async () => {
    const { address, localPart } = routedAddress("delivery");
    const ruleName = uniqueName("delivery-rule");

    await withNamedResource(
      ruleName,
      (name) => clients.emailRouting().ensureWorkerRoute({ zoneId, address, workerName: recorder, ruleName: name }),
      async () => {
        let observed = null;
        // Mail is not a request/response. Send, wait, and send once more rather than failing the run on
        // one delivery that took the long path — a live suite that flakes gets muted, and a muted suite
        // proves nothing.
        for (let send = 0; send < SEND_ATTEMPTS && observed === null; send += 1) {
          await sendProbe(address, localPart);
          for (let poll = 0; poll < POLL_ATTEMPTS && observed === null; poll += 1) {
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            observed = await readObservedInbound({ creds, namespaceId, nonce: localPart });
          }
        }

        expect(observed, "no message reached the Worker's email() handler").not.toBeNull();
        if (observed === null) return;

        // 1. It arrived, at the address the rule claimed.
        expect(observed.envelopeTo).toBe(address);
        expect(observed.rawSize).toBeGreaterThan(0);

        // 2. `message.headers` is populated, including the authentication headers workerd#6740 reports
        //    as missing. If that issue is ever fixed *or* regresses, this is where it surfaces.
        expect(observed.seen).toContain("authentication-results");
        expect(observed.seen).toContain("dkim-signature");
        expect(observed.seen).toContain("received");

        // 3. Cloudflare stamps its own verdict, and its authserv-id is what a consumer pins on.
        //    `@pithy-sh/support`'s `guard.authservId` is configured from exactly this string.
        expect(observed.authenticationResults.length).toBeGreaterThan(0);
        expect(observed.authenticationResults[0]).toMatch(/^mx\.cloudflare\.net;/);

        // 4. The sender's own headers survive delivery untouched. Together with (3) that is the whole
        //    trust rule: Cloudflare prepends its verdict, strips nothing below it, so only the topmost
        //    `Authentication-Results` is the receiver's and everything under it is attacker-controlled.
        const probeHeader = INBOUND_NONCE_HEADER.toLowerCase();
        expect(observed.rawHeaderNames).toContain(probeHeader);
        expect(observed.rawHeaderNames.indexOf("authentication-results")).toBeLessThan(
          observed.rawHeaderNames.indexOf(probeHeader),
        );

        // 5. DKIM survives the hop, so verifying it inside the Worker (#93) is at least possible.
        expect(observed.rawHeaderNames).toContain("dkim-signature");
      },
      (name) =>
        clients
          .emailRouting()
          .removeWorkerRoute({ zoneId, ruleName: name })
          .then(() => undefined),
    );
  }, 180_000);
});
