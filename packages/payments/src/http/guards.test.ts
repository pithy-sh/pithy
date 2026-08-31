// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import type { ControlPlaneContext } from "@pithy-sh/core/src/controlPlane/context";
import {
  ControlPlaneInsufficientScopeError,
  ControlPlaneInvalidCredentialError,
} from "@pithy-sh/core/src/controlPlane/error/errors";
import { type ControlPlaneVerifier, requireControlPlane } from "@pithy-sh/core/src/controlPlane/http/guard";
import {
  type ControlPlaneRequirement,
  ControlPlaneScope,
  scopeCovers,
} from "@pithy-sh/core/src/controlPlane/scope/scope";
import { pithyErrorHandler } from "@pithy-sh/core/src/error/http";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { requireAuth } from "./guards";
import {
  PAYMENTS_CATALOG_READ_SCOPE,
  PAYMENTS_CONTROL_PLANE_SCOPES,
  PAYMENTS_DISCOUNT_CREATE_SCOPE,
  PAYMENTS_DISCOUNT_READ_SCOPE,
  PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
  PAYMENTS_ENTITLEMENTS_READ_SCOPE,
  PAYMENTS_PURCHASES_READ_SCOPE,
  PAYMENTS_RECONCILE_READ_SCOPE,
  PAYMENTS_RECONCILE_RUN_SCOPE,
  PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
} from "./scopes";

/**
 * The gates on their own, before any route uses them.
 *
 * Two things are proved here, and they are different in kind. `requireAuth` is payments' own three lines, so
 * every branch of it is asserted directly. The control-plane gate is **core's**, so what is asserted is the
 * contract payments depends on: that it fails closed when the seam is not composed, that it asks for the
 * route's own scope, and — the one that matters most on a retrofit — that an ordinary app session opens
 * nothing on it, whatever the `AuthContext` carries. The interim gate this replaced checked a scope on
 * `c.var.auth`; if any part of that mechanism survived, the last test in this file would pass a user through.
 */

/** A caller the seam has already verified — what a real verifier returns on the happy path. */
const CALLER: ControlPlaneContext = {
  connectionId: "9e0a4f1c-2b6d-4a83-9f11-7c5e2d908a34",
  environment: "production",
  issuer: "https://app.pithy.sh",
  subject: "support-1",
  scope: PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
  grantedScopes: [...PAYMENTS_CONTROL_PLANE_SCOPES],
  keyId: "k-2026-01",
  tokenId: "b2f1c7e0-3a4d-4c19-8e77-1d6a0b53f942",
};

interface AppOptions {
  /** Compose the fake auth capability. Off means nothing ever sets `c.var.auth`. */
  withAuth?: boolean;
  /** Compose the control-plane seam by publishing a verifier. Absent means the seam is not composed. */
  verifier?: ControlPlaneVerifier;
}

/** An app whose fake auth middleware sets whatever the request headers ask for — or nothing at all. */
function app(guarded: MiddlewareHandler<PithyHonoEnv>, options: AppOptions = {}) {
  const hono = new Hono<PithyHonoEnv>();
  hono.onError(pithyErrorHandler);
  if (options.withAuth !== false) {
    hono.use("*", async (c, next) => {
      const user = c.req.header("x-user");
      const scopes = c.req.header("x-scopes")?.split(",").filter(Boolean) ?? [];
      c.set("auth", user ? { userId: user, sessionId: "s1", scopes } : null);
      await next();
    });
  }
  if (options.verifier) {
    const verifier = options.verifier;
    hono.use("*", async (c, next) => {
      c.set("controlPlaneVerifier", verifier);
      await next();
    });
  }
  hono.get("/gated", guarded, (c) => c.json({ ok: true, subject: c.var.controlPlane?.subject ?? null }));
  return (headers: Record<string, string> = {}) => hono.request("http://x/gated", { headers });
}

/** A verifier that records what the route demanded, then answers with a context or the seam's own refusal. */
function verifier(answer: ControlPlaneContext | Error, seen: ControlPlaneRequirement[] = []): ControlPlaneVerifier {
  return async (_request, requirement) => {
    seen.push(requirement);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const code = async (response: Response) => (await response.json<{ error: { code: string } }>()).error.code;

describe("requireAuth", () => {
  test("passes an authenticated caller through", async () => {
    const response = await app(requireAuth())({ "x-user": "ada" });
    expect(response.status).toBe(200);
  });

  test("denies an anonymous caller with 401", async () => {
    const response = await app(requireAuth())();
    expect(response.status).toBe(401);
    expect(await code(response)).toBe("auth/invalid_token");
  });

  test("denies when no auth capability is composed at all — the reason it is copied, not imported", async () => {
    // Nothing sets `c.var.auth`, so it is undefined rather than null. A gate that only checked for `null`
    // would fail open in exactly the deployment that has no auth.
    const response = await app(requireAuth(), { withAuth: false })({ "x-user": "ada" });
    expect(response.status).toBe(401);
  });
});

describe("the payments control-plane scopes", () => {
  test("every one is a valid ControlPlaneScope", async () => {
    // A scope that does not parse would be accepted on the route line and then never match a token, because
    // the token's own scope is parsed at the boundary. The gate would deny forever and read as a seam bug.
    for (const scope of PAYMENTS_CONTROL_PLANE_SCOPES) expect(ControlPlaneScope.parse(scope)).toBe(scope);
  });

  test("the aggregate is exactly the ten operations, reads first, in a stable order", () => {
    // What `pithy dashboard connect` offers for payments. A scope that exists and is offered nowhere is a
    // scope an adopter cannot grant, so the list and the route lines are asserted against each other.
    // Reads lead because they are the grant most connections want and the smallest one that makes a
    // dashboard useful — and because for a while there were none (#247). The catalog leads the reads: it
    // is the only one that names no account, and the smallest grant that makes a comp control possible.
    expect(PAYMENTS_CONTROL_PLANE_SCOPES).toEqual([
      PAYMENTS_CATALOG_READ_SCOPE,
      PAYMENTS_PURCHASES_READ_SCOPE,
      PAYMENTS_SUBSCRIPTIONS_READ_SCOPE,
      PAYMENTS_ENTITLEMENTS_READ_SCOPE,
      PAYMENTS_DISCOUNT_READ_SCOPE,
      PAYMENTS_RECONCILE_READ_SCOPE,
      PAYMENTS_ENTITLEMENT_GRANT_SCOPE,
      PAYMENTS_ENTITLEMENT_REVOKE_SCOPE,
      PAYMENTS_DISCOUNT_CREATE_SCOPE,
      // Last, and a write: starting a pass grants and revokes entitlements in bulk. It sits apart from
      // `:read` deliberately — a health monitor alarming on a stopped cron must not be able to move
      // anybody's access, and `scopeCovers` matches exactly, so holding the read confers nothing here.
      PAYMENTS_RECONCILE_RUN_SCOPE,
    ]);
  });

  test("a read scope confers no write, and the purchase log is not reachable through the subscription read", () => {
    // The reads are separate grants for the same reason grant and revoke are: `scopeCovers` matches
    // exactly, with no prefix or wildcard rule. A renewal monitor holding `payments:subscriptions:read`
    // must not be able to page the whole purchase log, and no read may comp anything.
    const renewalMonitor = [PAYMENTS_SUBSCRIPTIONS_READ_SCOPE];
    expect(scopeCovers(PAYMENTS_SUBSCRIPTIONS_READ_SCOPE, PAYMENTS_SUBSCRIPTIONS_READ_SCOPE, renewalMonitor)).toBe(
      true,
    );
    expect(scopeCovers(PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_PURCHASES_READ_SCOPE, renewalMonitor)).toBe(false);
    const reader = [PAYMENTS_PURCHASES_READ_SCOPE, PAYMENTS_SUBSCRIPTIONS_READ_SCOPE, PAYMENTS_ENTITLEMENTS_READ_SCOPE];
    expect(scopeCovers(PAYMENTS_ENTITLEMENT_GRANT_SCOPE, PAYMENTS_ENTITLEMENT_GRANT_SCOPE, reader)).toBe(false);
    // And what a project sells is a separate disclosure from what its customers bought, in both
    // directions: three read grants over the commerce confer nothing about the catalog (#300).
    expect(scopeCovers(PAYMENTS_CATALOG_READ_SCOPE, PAYMENTS_CATALOG_READ_SCOPE, reader)).toBe(false);
    expect(
      scopeCovers(PAYMENTS_ENTITLEMENTS_READ_SCOPE, PAYMENTS_ENTITLEMENTS_READ_SCOPE, [PAYMENTS_CATALOG_READ_SCOPE]),
    ).toBe(false);
    expect(scopeCovers(PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, reader)).toBe(false);
  });

  test("grant and revoke are separate grants — neither confers the other", () => {
    // The whole reason the pair replaced one `payments:admin` flag. `scopeCovers` matches exactly, with no
    // prefix rule, so a refund tool granted revoke cannot comp and a support tool granted grant cannot revoke.
    const granted = [PAYMENTS_ENTITLEMENT_REVOKE_SCOPE];
    expect(scopeCovers(PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, granted)).toBe(true);
    expect(scopeCovers(PAYMENTS_ENTITLEMENT_GRANT_SCOPE, PAYMENTS_ENTITLEMENT_GRANT_SCOPE, granted)).toBe(false);
    // Nor does presenting one token for the other route's operation get anywhere.
    expect(
      scopeCovers(PAYMENTS_ENTITLEMENT_GRANT_SCOPE, PAYMENTS_ENTITLEMENT_REVOKE_SCOPE, [
        ...PAYMENTS_CONTROL_PLANE_SCOPES,
      ]),
    ).toBe(false);
  });
});

describe("the control-plane gate on payments' admin routes", () => {
  test("fails closed when the seam is not composed", async () => {
    // No `controlplane()` in this Worker, so there is no verifier and the gate denies before it looks at
    // anything else. A capability that contributes admin routes into a Worker that never enabled the seam
    // must deny them, not leave them open because the thing meant to protect them is absent.
    const response = await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE))();
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("controlplane/not_connected");
  });

  test("an ordinary authenticated user opens nothing, even carrying the scope strings", async () => {
    // The retrofit's load-bearing assertion. The gate this replaced read `c.var.auth.scopes`, so a token
    // minted with these strings used to pass. It must now be worth nothing: the seam never populates
    // `c.var.auth`, and this gate never reads it.
    const response = await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE))({
      "x-user": "ada",
      "x-scopes": `payments:admin,${PAYMENTS_CONTROL_PLANE_SCOPES.join(",")}`,
    });
    expect(response.status).toBe(403);
    expect(await code(response)).toBe("controlplane/not_connected");
  });

  test("a session is not a credential even once the seam is composed", async () => {
    // The seam composed, the caller fully signed in and scoped, and no control-plane token on the request.
    // The verifier decides, and it decides on the token — so this is a credential failure, not a pass.
    const response = await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE), {
      verifier: verifier(new ControlPlaneInvalidCredentialError({ detail: "no credential presented" })),
    })({ "x-user": "ada", "x-scopes": PAYMENTS_CONTROL_PLANE_SCOPES.join(",") });
    expect(response.status).toBe(401);
    expect(await code(response)).toBe("controlplane/invalid_credential");
  });

  test("passes a verified management client through and puts it on the request", async () => {
    const response = await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE), {
      verifier: verifier(CALLER),
    })();
    expect(response.status).toBe(200);
    // `c.var.controlPlane`, never `c.var.auth` — which is what the handlers read to attribute the audit event.
    expect(await response.json()).toEqual({ ok: true, subject: "support-1" });
  });

  test("demands the route's own operation, not payments' whole grant", async () => {
    const seen: ControlPlaneRequirement[] = [];
    await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE), { verifier: verifier(CALLER, seen) })();
    await app(requireControlPlane(PAYMENTS_ENTITLEMENT_REVOKE_SCOPE), { verifier: verifier(CALLER, seen) })();
    expect(seen).toEqual([PAYMENTS_ENTITLEMENT_GRANT_SCOPE, PAYMENTS_ENTITLEMENT_REVOKE_SCOPE]);
  });

  test("propagates the seam's refusal when the connection lacks the scope", async () => {
    const response = await app(requireControlPlane(PAYMENTS_ENTITLEMENT_GRANT_SCOPE), {
      verifier: verifier(new ControlPlaneInsufficientScopeError({ detail: "connection grants [payments:read]" })),
    })();
    expect(response.status).toBe(403);
    // The throw-site context stays internal. A caller learns it lacks a grant, never which grants exist.
    const body = await response.json<{ error: { code: string; detail?: string } }>();
    expect(body.error.code).toBe("controlplane/insufficient_scope");
    expect(body.error.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("payments:read");
  });
});
