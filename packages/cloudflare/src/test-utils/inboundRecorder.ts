// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { z } from "zod";
import { CloudflareInvalidResponseError, CloudflareRequestError } from "../client/errors";
import type { CloudflareWorkersManager } from "../workers/workersManager";
import type { IntegrationCreds } from "./harness";

/**
 * A throwaway Worker that records what its `email()` handler was handed, and the reader that fetches
 * the record back out.
 *
 * ## Why a Worker has to exist at all
 *
 * An Email Routing rule cannot point at a Worker that is not there. Cloudflare rejects the rule with
 * `2016 Workers Script Info not found` at creation time, so a live test of `ensureWorkerRoute` has to
 * deploy a real script before it can create a real rule. That fact alone forces this file; everything
 * else here is what the script may as well do once it is running.
 *
 * ## Why the record goes through KV
 *
 * There is no inbox. The fixture zone's catch-all drops and it has zero verified destination
 * addresses, so nothing this suite sends can be read from a mailbox — and a test that waits for one
 * waits forever. The Worker is the destination, so the Worker has to be the witness: it writes what it
 * received to a KV namespace the test created, and the test reads it back over the REST API.
 *
 * ## What it deliberately does not do
 *
 * It does not classify, suppress, or parse MIME. Everything `@pithy-sh/email` actually does with an
 * inbound message is unit-tested against real D1 in the Workers pool, where a hostile message can be
 * constructed exactly rather than mailed and hoped for. What only a live delivery can answer is what
 * Cloudflare *hands* the handler — which headers survive, which Cloudflare adds, and whether a
 * sender's own headers arrive intact. So the recorder records, and asserts nothing.
 */

/** The KV binding the recorder writes through. */
export const INBOUND_RECORDER_BINDING = "OBSERVED";

/** The header a sender stamps to address its record. One send, one key, so parallel runs cannot collide. */
export const INBOUND_NONCE_HEADER = "X-Pithy-Probe";

/**
 * How much of the raw message is kept.
 *
 * A record is read back into a test's failure output, and a whole message is pages of base64. 16 KiB
 * covers the header block several times over, which is the part every question in #47 is about.
 */
const RAW_CAP = 16_384;

/** How long a record lives in KV. An hour outlives any run and reclaims itself if a teardown is missed. */
const RECORD_TTL_SECONDS = 3600;

/**
 * The recorder's source, as a module string.
 *
 * Kept verbatim here rather than built from a template because it is uploaded as-is and read by whoever
 * is debugging a delivery that did not arrive. It writes **once**, under the nonce it finds in the raw
 * message, and it must never throw: a throw inside `email()` is a delivery failure Cloudflare retries,
 * which turns one test message into several.
 */
export const INBOUND_RECORDER_MODULE = `
const NONCE = /^${INBOUND_NONCE_HEADER}:[ \\t]*(\\S+)[ \\t]*$/im;
const AUTH_RESULTS = /^Authentication-Results:[ \\t]*([\\s\\S]*?)(?=\\r?\\n[^ \\t])/gim;

/** Header names in the raw block, in order, lowercased. Duplicates kept — two DKIM signatures are two facts. */
function rawHeaderNames(raw) {
  const block = raw.split(/\\r?\\n\\r?\\n/)[0] ?? "";
  return block
    .split(/\\r?\\n/)
    .filter((line) => /^[A-Za-z0-9-]+:/.test(line))
    .map((line) => line.slice(0, line.indexOf(":")).toLowerCase());
}

export default {
  async email(message, env) {
    let record;
    let nonce = "unkeyed";
    try {
      const raw = await new Response(message.raw).text();
      nonce = NONCE.exec(raw)?.[1] ?? "unkeyed";
      record = {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        rawSize: message.rawSize,
        seen: [...message.headers.keys()].map((name) => name.toLowerCase()).sort(),
        rawHeaderNames: rawHeaderNames(raw),
        authenticationResults: [...raw.matchAll(AUTH_RESULTS)].map((match) => match[1].trim()),
        raw: raw.slice(0, ${RAW_CAP}),
      };
    } catch (error) {
      record = { failure: String(error) };
    }
    await env.${INBOUND_RECORDER_BINDING}.put(nonce, JSON.stringify(record), { expirationTtl: ${RECORD_TTL_SECONDS} });
  },
};
`;

/**
 * What the recorder saw — validated on the way back in, because a KV read is a boundary like any other.
 *
 * The Worker that wrote it is ours, which is exactly the argument that has let every unvalidated
 * internal read through. A truncated write or a stale record from an older recorder deserves a Zod
 * failure naming the field, not a `TypeError` three assertions later.
 */
export const ObservedInbound = z
  .object({
    envelopeFrom: z.string().describe("The SMTP envelope sender, as `message.from` reported it."),
    envelopeTo: z.string().describe("The SMTP envelope recipient, as `message.to` reported it."),
    rawSize: z.number().describe("The message size in bytes, as `message.rawSize` reported it."),
    seen: z
      .array(z.string())
      .describe("Header names on `message.headers`, lowercased and sorted — the surface workerd#6740 is about."),
    rawHeaderNames: z
      .array(z.string())
      .describe("Header names in the raw MIME block, lowercased, in wire order, duplicates kept."),
    authenticationResults: z
      .array(z.string())
      .describe("Every `Authentication-Results` value in the raw block, in wire order: the topmost is the receiver's."),
    raw: z.string().describe("The delivered message, truncated to the first 16 KiB."),
  })
  .describe("One inbound message as the Worker's `email()` handler received it.");

/** What the recorder saw. */
export type ObservedInbound = z.output<typeof ObservedInbound>;

/** A trivial module Worker: enough for an Email Routing rule to be allowed to point at it. */
export const PLACEHOLDER_INBOUND_MODULE = "export default { async email() {} };\n";

/** The module filename every throwaway Worker here is uploaded under. */
export const INBOUND_MODULE_NAME = "worker.mjs";

/**
 * Deploy the recorder at `scriptName`, bound to the KV namespace records are written to.
 *
 * Uploaded through `CloudflareWorkersManager.createWorker` like anything else. It briefly was not:
 * #373 was a manager that could not upload a module to the live API at all, and this file carried a
 * hand-rolled `fetch` around it. The manager is the path again — a helper that exists because the
 * product is broken is the thing people copy.
 */
export async function deployInboundRecorder(options: {
  workers: CloudflareWorkersManager;
  scriptName: string;
  namespaceId: string;
}): Promise<void> {
  const { workers, scriptName, namespaceId } = options;
  await workers.createWorker(
    scriptName,
    { bindings: [{ type: "kv_namespace", name: INBOUND_RECORDER_BINDING, namespace_id: namespaceId }] },
    { name: INBOUND_MODULE_NAME, body: INBOUND_RECORDER_MODULE },
  );
}

/**
 * The record for one nonce, or null while nothing has arrived.
 *
 * Null rather than a throw for the missing case, because "not yet" is the normal state of a mail
 * delivery: the caller polls. A 404 from KV is that state; anything else is a real failure and throws.
 */
export async function readObservedInbound(options: {
  creds: IntegrationCreds;
  namespaceId: string;
  nonce: string;
}): Promise<ObservedInbound | null> {
  const { creds, namespaceId, nonce } = options;
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/storage/kv/namespaces/${namespaceId}/values/${encodeURIComponent(nonce)}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${creds.apiToken}` } });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new CloudflareRequestError({
      message: "Could not read the recorded inbound message.",
      action: "Check the token carries Workers KV Storage: Edit on this account.",
      detail: `KV read for the inbound record returned ${response.status}.`,
    });
  }

  const body: unknown = JSON.parse(await response.text());
  // The recorder writes `{ failure }` rather than throwing, so a handler that broke says so here
  // instead of arriving as a Zod complaint about seven missing fields.
  if (typeof body === "object" && body !== null && "failure" in body) {
    throw new CloudflareInvalidResponseError({
      message: "The inbound recorder could not read the message it was handed.",
      detail: `The recorder Worker recorded a failure: ${String((body as { failure: unknown }).failure)}`,
    });
  }
  return ObservedInbound.parse(body);
}
