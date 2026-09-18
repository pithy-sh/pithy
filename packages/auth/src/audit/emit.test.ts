// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

/**
 * **The rule over `PATH_EVENTS`, asserted for every entry rather than for the paths somebody probed.**
 *
 * #627 was two claims about the same table, found a year apart and fixed the same way. A refused request
 * wrote `outcome: "success"`, because Better Auth catches an endpoint's `APIError` into a result and runs
 * the `after` hooks over it anyway. Then a *completed* request wrote it too, because a refusal can answer
 * 200: `/sign-out` deletes nothing and says so cheerfully, and `/email-otp/send-verification-otp`
 * declines to send and answers `{"success":true}` on purpose, so that a caller cannot tell a registered
 * address from a stranger's. Both times every entry in the table was exposed, not the one that was
 * probed.
 *
 * **So this file's reach is the table, exactly.** It states what it covers, and covers what it states:
 *
 * - Every entry in {@link PATH_EVENTS}, walked. A fifth path added tomorrow is covered the day it lands.
 * - Every member of `PathEvidence`, through {@link EVIDENCE_OBSERVERS} and the fixtures below — both
 *   total records over the union, so a new kind of evidence does not compile until this file says how it
 *   is made present and how it reads when it is absent.
 * - `emitAfterRequest`'s decision, and nothing about whether the markers it reads are set correctly:
 *   `endedSession`, `messageQueued` and `returned` arrive here as fixtures. **Whether the real request
 *   populates them is `emit.workers.test.ts`'s**, which drives a real instance over real D1 and checks a
 *   queued message against `pithy_email_jobs` and a sign-out against `pithy_auth_sessions` — outside the
 *   thing being asserted about. Neither file is sufficient alone, and this one is not the gate for
 *   anything that happens before `emitAfterRequest` is called.
 * - The path-keyed events only. `emitProviderAccountChanged` (keyed by the account row) and the direct
 *   emitters — `emitTokenRefresh`, `emitDeviceRevoked`, `emitControlPlaneAction` — are called by code
 *   that has already done the thing it records, so the evidence rule has nothing to add to them. The
 *   rule is for events written by a hook that did not do the work.
 */

import type { AuditEventInput } from "@pithy-sh/core/src/audit/auditEvent";
import type { AuditEmit } from "@pithy-sh/core/src/audit/recorder";
import { APIError } from "better-auth/api";
import { describe, expect, test } from "vitest";
import {
  type AfterRequest,
  EVIDENCE_OBSERVERS,
  emitAfterRequest,
  emitProviderAccountChanged,
  PATH_EVENTS,
  type PathEvidence,
  wasRefused,
} from "./emit";

function capturing(): { emit: AuditEmit; events: AuditEventInput[] } {
  const events: AuditEventInput[] = [];
  return { events, emit: async (event) => void events.push(event) };
}

/**
 * A request that completed and evidences **nothing** — no session gone, no message queued, no token in
 * the payload. Every case starts here, so evidence is something a case adds rather than something the
 * fixture leaks in.
 */
function request(path: string, over: Partial<AfterRequest> = {}): AfterRequest {
  return {
    path,
    headers: new Headers({ "cf-connecting-ip": "203.0.113.7" }),
    newSession: null,
    currentUserId: "user-1",
    returned: { ok: true },
    endedSession: null,
    messageQueued: false,
    ...over,
  };
}

/**
 * How each kind of evidence is made present — a total record over `PathEvidence`, so a kind added to the
 * union is a compile error here until this file says what having it looks like. That is the half that
 * stops the walk below from going stale: a new path can only declare evidence this file can produce.
 */
const EVIDENCE_PRESENT: Readonly<Record<PathEvidence, Partial<AfterRequest>>> = {
  "session-ended": { endedSession: { userId: "user-1" } },
  "message-queued": { messageQueued: true },
  "token-minted": { returned: { token: "ey.header.payload.signature" } },
};

/** A completed request carrying whatever this path declares it needs. */
function evidenced(path: string, over: Partial<AfterRequest> = {}): AfterRequest {
  const evidence = PATH_EVENTS[path]?.evidence;
  return request(path, { ...(evidence ? EVIDENCE_PRESENT[evidence] : {}), ...over });
}

const PATHS = Object.keys(PATH_EVENTS);
const EVIDENCE_KINDS = Object.keys(EVIDENCE_OBSERVERS) as PathEvidence[];

describe("the fixtures are the evidence, and are proven to be", () => {
  // Every assertion below this block is only as good as these two lines: a fixture that changes nothing
  // would make "with evidence" and "without evidence" the same request, and half the walk would pass
  // for free. So each observer is read directly, both ways, before anything is asserted through it.
  test.each(EVIDENCE_KINDS)("nothing evidences %s in a bare request", (kind) => {
    expect(EVIDENCE_OBSERVERS[kind](request("/x"))).toBe(false);
  });

  test.each(EVIDENCE_KINDS)("the %s fixture is seen by its own observer", (kind) => {
    expect(EVIDENCE_OBSERVERS[kind](request("/x", EVIDENCE_PRESENT[kind]))).toBe(true);
  });

  test("every audited path declares evidence somebody knows how to observe", () => {
    // The type says this; a cast anywhere in the table would not. It is one line and it is the whole
    // structural claim: an entry that claims an outcome it cannot evidence does not exist.
    for (const path of PATHS) expect(EVIDENCE_KINDS).toContain(PATH_EVENTS[path]?.evidence);
  });
});

describe("a refused request is never a success", () => {
  test("the table is not empty, so walking it is not a vacuous pass", () => {
    expect(PATHS.length).toBeGreaterThan(0);
  });

  test.each(PATHS)("%s writes `denied`, not `success`, when the endpoint refused", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, evidenced(path, { returned: new APIError("UNAUTHORIZED", { message: "no" }) }));

    const written = events.filter((e) => e.action === PATH_EVENTS[path]?.action);
    expect(written.map((e) => e.outcome)).not.toContain("success");
  });

  // The rule above is satisfied by an emitter that never writes anything at all. This is the half that
  // says it must still record the request it was refused — a refused OTP send is exactly the row an
  // abuse count is made of. It holds on every path, `silent` ones included: a refusal is an attempt.
  test.each(PATHS)("%s still records the refused attempt, as `denied`", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, evidenced(path, { returned: new APIError("BAD_REQUEST", { message: "no" }) }));

    expect(events).toContainEqual(expect.objectContaining({ action: PATH_EVENTS[path]?.action, outcome: "denied" }));
  });

  // …and this is the half that says the fix did not simply stop the table emitting. Without it, deleting
  // every entry would pass both assertions above.
  test.each(PATHS)("%s writes `success` when the endpoint completed and the evidence is there", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, evidenced(path));

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

describe("a completed response is not a completed action", () => {
  // **The gate #627's last half needed, and it walks the table rather than naming the endpoint that was
  // probed.** Every path, answering without an error, with its own evidence absent: nothing here may be
  // a `success`. A fifth entry declaring evidence the request never carries is caught the day it lands.
  test.each(PATHS)("%s never writes `success` on a completed response with no evidence", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request(path));

    const written = events.filter((e) => e.action === PATH_EVENTS[path]?.action);
    expect(written.map((e) => e.outcome)).not.toContain("success");
  });

  test.each(PATHS)("%s records what its entry says an unevidenced completion is", async (path) => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request(path));

    const written = events.filter((e) => e.action === PATH_EVENTS[path]?.action);
    // `denied` where a rule declined to act — the row an abuse count is made of. `silent` where nothing
    // was attempted: `/sign-out` with no session confirms a state that already held.
    const expected = PATH_EVENTS[path]?.withoutEvidence === "denied" ? ["denied"] : [];
    expect(written.map((e) => e.outcome)).toEqual(expected);
  });

  test("evidence from earlier in the request does not rescue a refusal", async () => {
    // `/sign-out` can be refused (the CSRF gate) after something else in the same request already ended
    // a session. The refusal is the answer; a marker lying around is not evidence that this endpoint did
    // anything, and `denied` is what a turned-away attempt is.
    const { emit, events } = capturing();
    await emitAfterRequest(emit, evidenced("/sign-out", { returned: new APIError("FORBIDDEN", { message: "no" }) }));

    expect(events.filter((e) => e.action === "auth/signout").map((e) => e.outcome)).toEqual(["denied"]);
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

describe("what each path's evidence actually is", () => {
  // The walk above proves the rule holds for every entry; these name the four, so a reader can see what
  // the table claims without reconstructing it from a fixture record.
  test("/sign-out is the session row that disappeared, and it names whose", async () => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/sign-out", { currentUserId: null, endedSession: { userId: "owner-9" } }));

    expect(events).toContainEqual(
      expect.objectContaining({ action: "auth/signout", outcome: "success", actorId: "owner-9" }),
    );
  });

  test("…and with nothing ended it records nothing at all, not a denial", async () => {
    // Named rather than derived from `withoutEvidence`, on purpose: the walk above proves the emitter
    // obeys the table, which a table saying the wrong thing would satisfy just as well. Nothing was
    // attempted and nothing refused — an expired cookie confirming a state that already held.
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/sign-out"));

    expect(events.map((e) => e.action)).not.toContain("auth/signout");
  });

  test("/token is a token in the payload, not a 200", async () => {
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/token", { returned: { token: "" } }));

    expect(events.filter((e) => e.action === "auth/token_refresh").map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("a send is the message, not the `{success:true}` the endpoint answers either way", async () => {
    // The row `/email-otp/send-verification-otp` was writing for an address it had declined to mail.
    const { emit, events } = capturing();
    await emitAfterRequest(emit, request("/email-otp/send-verification-otp", { returned: { success: true } }));

    expect(events.filter((e) => e.action === "auth/otp_sent").map((e) => e.outcome)).toEqual(["denied"]);
  });

  test("…and the same call with a message queued is the success", async () => {
    const { emit, events } = capturing();
    await emitAfterRequest(
      emit,
      request("/email-otp/send-verification-otp", { returned: { success: true }, messageQueued: true }),
    );

    expect(events.filter((e) => e.action === "auth/otp_sent").map((e) => e.outcome)).toEqual(["success"]);
  });
});
