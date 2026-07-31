// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { CapabilityEmailHandler } from "@pithy-sh/core/src/capability/capability";
import { createWorkerLogger } from "@pithy-sh/core/src/logger/worker";
import type { SupportWiring } from "../capability";
import { supportDatabase } from "../data/tables";
import { makeClassifyDispatcher, resolveDb, type SupportEnv } from "../http/resolve";
import { resolveSenderUserId } from "../link/sender";
import { ingestInbound } from "./ingest";

/**
 * The `email()` seam — a thin shell over `ingestInbound`.
 *
 * Everything interesting lives in `ingest.ts`, with every dependency injected; this file exists only
 * to read bindings off the untyped Worker env and to make the two decisions that belong at the
 * boundary rather than inside the orchestration.
 *
 * ## It never throws, and that is not laziness
 *
 * A Worker has one `email()` entry, and `createEntrypoint` fans every message to **every**
 * capability that declares a handler — sequentially, in registration order. An exception thrown here
 * would propagate out of that loop and stop the handlers after it from running, so a malformed
 * message addressed to support could take out `@pithy-sh/email`'s bounce processing, which is how
 * suppression stops working and an adopter's sending reputation quietly degrades. One capability's
 * bad day must not be another's.
 *
 * So the handler catches, logs, and returns. The message is left untouched, which the runtime treats
 * as a drop — correct, because a message this Worker could not store is one it cannot act on either.
 *
 * ## There is no request logger here
 *
 * `c.var.log` belongs to a `fetch`. An inbound message has no request, so the handler builds its own
 * logger from the env rather than pretending otherwise.
 */
export function createSupportEmailHandler(wiring: SupportWiring): CapabilityEmailHandler {
  return async (message, env) => {
    const bindings = env as unknown as SupportEnv;
    const log = createWorkerLogger({
      name: "support",
      fields: { env: typeof env.ENVIRONMENT === "string" ? env.ENVIRONMENT : "unknown" },
    });

    // A capability configured with no addresses claims nothing. Say so once, at warn, rather than
    // parsing every message the Worker receives to reach the same conclusion silently.
    if (wiring.config.inboundAddresses.length === 0) {
      log.warn("support has no inboundAddresses configured — every message is ignored", {
        action: "Set `inboundAddresses` on the support capability in pithy.config.ts.",
      });
      return;
    }

    try {
      const d1 = resolveDb(env);

      // Refuse on the *declared* size before buffering. `checkSize` runs again inside ingest — it is
      // the orchestration's own contract and must hold when called directly — but by then the whole
      // message is already in memory, which is exactly the cost the size bound exists to avoid.
      // `rawSize` is the runtime's own count and needs no bytes read to consult.
      const declared = message.rawSize;
      if (typeof declared === "number" && declared > wiring.config.guard.maxRawBytes) {
        log.warn("support inbound message refused before parsing", {
          reason: "too_large",
          rawSize: declared,
          maxRawBytes: wiring.config.guard.maxRawBytes,
        });
        return;
      }

      const raw = await new Response(message.raw).arrayBuffer();

      const outcome = await ingestInbound(
        {
          db: supportDatabase(d1),
          config: wiring.config,
          bucket: bindings.SUPPORT_BUCKET,
          fts: wiring.config.search.fts,
          dispatchClassify: makeClassifyDispatcher(env, log),
          linkSender: (address) => resolveSenderUserId(d1, address),
          emit: wiring.emit,
          log,
          newId: () => crypto.randomUUID(),
          now: () => new Date(),
        },
        { raw, envelopeTo: message.to, envelopeFrom: message.from },
      );

      if (outcome.handled && !outcome.duplicate) {
        log.info("support message stored", {
          threadId: outcome.threadId,
          messageId: outcome.messageId,
          newThread: outcome.newThread,
          attachments: outcome.attachments,
        });
      }
    } catch (error) {
      // Swallowed on purpose — see the note above. The failure is logged with everything an operator
      // needs and nothing the sender wrote.
      log.error("support inbound handling failed", { error });
    }
  };
}
