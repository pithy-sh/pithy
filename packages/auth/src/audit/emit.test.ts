// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The rule over `PATH_EVENTS`, asserted for every entry rather than for the three somebody probed.**
 *
 * #627's second half was that a refused request wrote `outcome: "success"`. Better Auth catches an
 * endpoint's `APIError` into a result and runs the `after` hooks over it anyway, so *every* entry in the
 * table was exposed — `/token` answering 401, `/email-otp/send-verification-otp` answering 400 with
 * `INVALID_EMAIL`, and any entry added after this was written. A test naming those paths would go stale
 * the moment somebody adds a fifth; these walk the table, so a new entry is covered the day it lands or
 * this file reddens.
 *
 * The end-to-end half lives in `emit.workers.test.ts`, which drives real refusals through a real
 * instance over real D1 — that is what proves `ctx.context.returned` actually carries the refusal here.
 * This file proves what `emitAfterRequest` does with it, for all of it.
 */

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { APIError } from "better-auth/api";
import { describe, expect, test } from "vitest";
import { type AfterRequest, emitAfterRequest, emitProviderAccountChanged, PATH_EVENTS, wasRefused } from "./emit";

function capturing(): { emit: AuditEmit; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

function request(path: string, over: Partial<AfterRequest> = {}): AfterRequest {
  return {
    path,
    headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }),
    newSession: null,
    currentUserId: "user-1",
    returned: { ok: true },
    endedSession: { userId: "user-1" },
    ...over,
  };
}

const PATHS = Object.keys(PATH_EVENTS);

describe("a refused request is never a success", () => {
  test("the table is not empty, so walking it is not a vacuous pass", () => {
    expect(PATHS.length).toBeGreaterThan(0);
  });

  test.each(PATHS)("%s writes `denied`, not `success`, when the endpoint refused", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request(path, { returned: new APIError("UNAUTHORIZED", { message: "no" }) }));

    const written = events.filter((e) => e.action === PATH_EVENTS[path]?.action);
    expect(written.map((e) => e.outcome)).not.toContain("success");
  });

  // The rule above is satisfied by an emitter that never writes anything at all. This is the half that
  // says it must still record the request it was refused — a refused OTP send is exactly the row an
  // abuse count is made of.
  test.each(PATHS)("%s still records the refused attempt, as `denied`", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request(path, { returned: new APIError("BAD_REQUEST", { message: "no" }) }));

    expect(events).toContainEqual(expect.objectContaining({ action: PATH_EVENTS[path]?.action, outcome: "denied" }));
  });

  // …and this is the half that says the fix did not simply stop the table emitting. Without it, deleting
  // every entry would pass both assertions above.
  test.each(PATHS)("%s writes `success` when the endpoint completed", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request(path));

    expect(events).toContainEqual(expect.objectContaining({ action: PATH_EVENTS[path]?.action, outcome: "success" }));
  });

  test("a refusal writes no sign-in, whatever the session context claims", async () => {
    // A refused request created no session. If `newSession` is somehow set, that is a contradiction to
    // drop rather than a sign-in to record.
    const { emit, events } = capturing();
    await emitAfterRequest(
      emit,
      request("/token", {
        returned: new APIError("UNAUTHORIZED", { message: "no" }),
        newSession: { userId: "user-1", sessionId: "s-1", deviceId: "d-1" },
      }),
    );

    expect(events.map((e) => e.action)).not.toContain("auth/signin");
    expect(events.map((e) => e.action)).not.toContain("auth/device_registered");
  });
});

describe("wasRefused", () => {
  test("an APIError is a refusal", () => {
    expect(wasRefused(new APIError("UNAUTHORIZED", { message: "no" }))).toBe(true);
  });

  test("a 4xx-shaped object is a refusal even when `instanceof` cannot see it", () => {
    // A duplicated `better-auth` module breaks the class identity. Degrading to "everything succeeded"
    // is the exact defect this function exists to end, so the shape is checked too.
    expect(wasRefused({ statusCode: 401, message: "Unauthorized" })).toBe(true);
    expect(wasRefused({ statusCode: 500 })).toBe(true);
  });

  test("an ordinary response body is not a refusal", () => {
    expect(wasRefused({ token: "ey…" })).toBe(false);
    expect(wasRefused({ success: true })).toBe(false);
    expect(wasRefused({ statusCode: 200 })).toBe(false);
    expect(wasRefused(undefined)).toBe(false);
    expect(wasRefused(null)).toBe(false);
  });
});

describe("a provider change names whoever caused it", () => {
  const account = { id: "acct-1", userId: "owner-1", providerId: "google" };
  const operator = new Headers({ "cf-connecting-ip": "203.0.113.200", "user-agent": "admin-console/2" });

  test("an authenticated caller is the actor, and the owner is the subject", async () => {
    const { emit, events } = capturing();
    await emitProviderAccountChanged(emit, {
      change: "unlink",
      account,
      callerId: "owner-1",
      fromRequest: true,
      headers: operator,
    });

    expect(events[0]).toMatchObject({
      actorType: "user",
      actorId: "owner-1",
      ip: "203.0.113.200",
      metadata: { provider: "google", userId: "owner-1" },
    });
  });

  test("a caller who is not the owner is named as the actor, not the owner", async () => {
    // `/unlink-account` cannot be driven this way, but `delete.after` fires for any caller Better Auth
    // or a plugin routes through the account model. Writing the owner's id here is the misattribution.
    const { emit, events } = capturing();
    await emitProviderAccountChanged(emit, {
      change: "unlink",
      account,
      callerId: "somebody-else",
      fromRequest: true,
      headers: operator,
    });

    expect(events[0]).toMatchObject({ actorType: "user", actorId: "somebody-else" });
    expect(events[0]?.metadata).toMatchObject({ userId: "owner-1" });
  });

  test("a cascade borrows nobody's identity and nobody's address", async () => {
    // **The row the review found.** `delete.after` fires on the user-deletion cascade too, and the
    // headers in scope belong to whoever triggered it — an operator, not the account's owner. Recorded
    // as the owner's own action from the operator's address, it reads as evidence that they did it.
    const { emit, events } = capturing();
    await emitProviderAccountChanged(emit, {
      change: "unlink",
      account,
      callerId: null,
      fromRequest: false,
      headers: operator,
    });

    expect(events[0]).toMatchObject({ actorType: "system", metadata: { userId: "owner-1" } });
    expect(events[0]?.actorId ?? null).toBeNull();
    expect(events[0]?.ip ?? null).toBeNull();
    expect(events[0]?.userAgent ?? null).toBeNull();
    expect(JSON.stringify(events[0])).not.toContain("203.0.113.200");
  });

  test("a request with no session is anonymous, not the owner and not a system job", async () => {
    // A first social sign-up completes at `/callback/:id`, which holds no session yet. Somebody was
    // calling, so the request's address is a fact about this row; nobody was signed in, so no id is.
    const { emit, events } = capturing();
    await emitProviderAccountChanged(emit, {
      change: "link",
      account,
      callerId: null,
      fromRequest: true,
      headers: new Headers({ "cf-connecting-ip": "192.0.2.5" }),
    });

    expect(events[0]).toMatchObject({ actorType: "anonymous", ip: "192.0.2.5" });
    expect(events[0]?.actorId ?? null).toBeNull();
  });
});

describe("an endpoint that did nothing records nothing", () => {
  test("/sign-out with no session ended writes no signout row", async () => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/sign-out", { endedSession: null }));

    expect(events.map((e) => e.action)).not.toContain("auth/signout");
  });

  test("a path with no evidence requirement is unaffected by it", async () => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/token", { endedSession: null }));

    expect(events).toContainEqual(expect.objectContaining({ action: "auth/token_refresh", outcome: "success" }));
  });
});
