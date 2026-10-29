// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyMiddleware } from "@pithy-sh/core/src/capability/capability";
import { ConsentAuditActions } from "../audit/actions";
import { type ConsentRoutesOptions, storeFor } from "./routes";
import { clearVisitor, readVisitor } from "./visitor";

/**
 * Carry a visitor's consent into the account they sign in as.
 *
 * The first request that arrives both signed in and holding a visitor's device-id cookie, or a phone's visitor header,
 * is the sign-in, as far as consent can tell: the merge is recorded then, as one append-only row and one audit event,
 * and the cookie is let go. A phone keeps its id; once merged, it is no visitor again. The visitor's rows are never
 * rewritten — the account's answer reads them through the merge.
 *
 * **After the request, never in its way.** It runs once the downstream handlers have, so it sees the identity the
 * auth middleware set wherever it sits in the composition, and a merge that fails is logged and costs nothing but
 * the merge: the cookie stays, and the next signed-in request tries again.
 */
export function mergeOnSignIn(options: ConsentRoutesOptions): PithyMiddleware {
  return (app) => {
    app.use("*", async (c, next) => {
      await next();
      const auth = c.var.auth;
      const visitor = readVisitor(c);
      if (!auth || visitor === null) return;
      try {
        const { merge, created } = await storeFor(c, options).merge(visitor.id, auth.userId);
        if (created) {
          await c.var.emit({
            action: ConsentAuditActions.merged,
            outcome: "success",
            severity: "info",
            actorType: "user",
            actorId: auth.userId,
            resourceType: "consent",
            resourceId: `account:${auth.userId}`,
            requestId: c.req.header("cf-ray"),
            ip: c.req.header("cf-connecting-ip"),
            userAgent: c.req.header("user-agent"),
            metadata: { visitorId: merge.visitorId, mergeId: merge.id },
          });
        }
        if (visitor.carriedBy === "cookie") clearVisitor(c);
      } catch (cause) {
        c.var.log.child("consent").warn("A visitor's consent could not be merged at sign-in; it will be tried again.", {
          error: cause instanceof Error ? cause.message : "unknown",
        });
      }
    });
  };
}
