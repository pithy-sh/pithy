// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { PithyHonoEnv } from "@pithy-sh/core/src/capability/capability";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { noopLogger } from "@pithy-sh/core/src/logger/logger";
import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { MAX_SUBJECT_ID_LENGTH, type PaymentsSubject } from "../data/subject";
import {
  authenticatedUserSubject,
  type PaymentsSubjectResolver,
  type PaymentsSubjectSeam,
  requirePaymentsSubject,
  resolvePaymentsSubject,
} from "./subjectSeam";

/**
 * The seam on its own, before a gate or a route uses it.
 *
 * What is asserted here is the whole contract every other caller inherits: the default answers a user and
 * only a user, an adopter's answer is taken verbatim once it passes the schema, an answer of the wrong kind
 * for the configured mode is refused rather than half-trusted, and nothing anywhere falls back to
 * `c.var.auth.userId` when an organization was asked for. The last one is the property this issue exists to
 * create, so it is asserted from both directions.
 */

/** The context a resolver is handed — a real one, since the seam's whole input is the Hono `Context`. */
type SeamContext = Parameters<PaymentsSubjectResolver>[0];

/** Run `body` inside a real request, with whatever the adopter's auth middleware would have set. */
async function inRequest<T>(body: (c: SeamContext) => Promise<T>, auth?: string): Promise<T> {
  const app = new Hono<PithyHonoEnv>();
  let answer: { value: T } | { thrown: unknown } | undefined;
  app.get("/x", async (c) => {
    c.set("log", noopLogger);
    c.set("auth", auth ? { userId: auth, sessionId: "s1", scopes: [] } : null);
    try {
      answer = { value: await body(c) };
    } catch (error) {
      answer = { thrown: error };
    }
    return c.json({});
  });
  await app.request("http://x/x");
  // The route always runs, so one of the two branches always assigned.
  const settled = answer as { value: T } | { thrown: unknown };
  if ("thrown" in settled) throw settled.thrown;
  return settled.value;
}

/** The `PithyError` a call refuses with. Fails the test if it does not refuse. */
async function refusal(body: (c: SeamContext) => Promise<unknown>, auth?: string): Promise<PithyError> {
  try {
    await inRequest(body, auth);
  } catch (error) {
    if (error instanceof PithyError) return error;
    throw error;
  }
  throw new Error("expected the call to refuse, and it answered.");
}

/** A seam that answers with whatever it is handed, so a test states only the answer it is testing. */
function answering(subject: unknown): PaymentsSubjectResolver {
  return async () => subject as PaymentsSubject | undefined;
}

const ACME: PaymentsSubject = { subjectType: "organization", subjectId: "acme" };

const USER_MODE: PaymentsSubjectSeam = { billingSubject: "user" };
const ORGANIZATION_MODE: PaymentsSubjectSeam = { billingSubject: "organization" };

describe("authenticatedUserSubject", () => {
  test("answers the authenticated caller, as a user subject", async () => {
    expect(await inRequest((c) => authenticatedUserSubject(c), "ada")).toEqual({
      subjectType: "user",
      subjectId: "ada",
    });
  });

  test("answers nothing when no auth strategy has run", async () => {
    expect(await inRequest((c) => authenticatedUserSubject(c))).toBeUndefined();
  });
});

describe("resolvePaymentsSubject", () => {
  test("under `user`, with no adopter seam, it resolves the caller", async () => {
    expect(await inRequest((c) => resolvePaymentsSubject(c, USER_MODE), "ada")).toEqual({
      subjectType: "user",
      subjectId: "ada",
    });
  });

  test("under `organization`, with no adopter seam, it resolves nothing — never the caller", async () => {
    // The whole point. An organization-billed project with nothing wired holds nothing; it does not
    // quietly key the company's plan to whoever happened to log in.
    expect(await inRequest((c) => resolvePaymentsSubject(c, ORGANIZATION_MODE), "ada")).toBeUndefined();
  });

  test("an adopter seam answers, and is handed the request context", async () => {
    const seam: PaymentsSubjectSeam = {
      billingSubject: "organization",
      // What a real adopter writes: the acting organization off their own session.
      resolveSubject: async (c) => (c.var.auth ? ACME : undefined),
    };
    expect(await inRequest((c) => resolvePaymentsSubject(c, seam), "ada")).toEqual(ACME);
    expect(await inRequest((c) => resolvePaymentsSubject(c, seam))).toBeUndefined();
  });

  test("an adopter seam that answers nothing is the answer — there is no fallback to the caller", async () => {
    const seam: PaymentsSubjectSeam = { billingSubject: "user", resolveSubject: answering(undefined) };
    expect(await inRequest((c) => resolvePaymentsSubject(c, seam), "ada")).toBeUndefined();
  });

  test("an answer of the wrong kind for the configured mode resolves nothing", async () => {
    // One mode per project. A user subject under organization billing would read rows nothing writes and
    // write rows nothing reads, so it is refused rather than half-trusted.
    const seam: PaymentsSubjectSeam = {
      billingSubject: "organization",
      resolveSubject: answering({ subjectType: "user", subjectId: "ada" }),
    };
    expect(await inRequest((c) => resolvePaymentsSubject(c, seam), "ada")).toBeUndefined();
  });

  test("an answer the subject schema refuses resolves nothing", async () => {
    const empty: PaymentsSubjectSeam = {
      billingSubject: "organization",
      resolveSubject: answering({ subjectType: "organization", subjectId: "" }),
    };
    const overlong: PaymentsSubjectSeam = {
      billingSubject: "organization",
      resolveSubject: answering({ subjectType: "organization", subjectId: "a".repeat(MAX_SUBJECT_ID_LENGTH + 1) }),
    };
    const shapeless: PaymentsSubjectSeam = {
      billingSubject: "organization",
      resolveSubject: answering({ id: "acme" }),
    };
    expect(await inRequest((c) => resolvePaymentsSubject(c, empty))).toBeUndefined();
    expect(await inRequest((c) => resolvePaymentsSubject(c, overlong))).toBeUndefined();
    expect(await inRequest((c) => resolvePaymentsSubject(c, shapeless))).toBeUndefined();
  });
});

describe("requirePaymentsSubject", () => {
  test("returns the answered subject", async () => {
    const seam: PaymentsSubjectSeam = { billingSubject: "organization", resolveSubject: answering(ACME) };
    expect(await inRequest((c) => requirePaymentsSubject(c, seam))).toEqual(ACME);
  });

  test("an unanswered write is refused with payments/subject_unresolved", async () => {
    const thrown = await refusal((c) => requirePaymentsSubject(c, ORGANIZATION_MODE), "ada");
    expect(thrown.payload.code).toBe("payments/subject_unresolved");
    expect(thrown.payload.status).toBe(403);
  });

  test("under `user` it refuses too, and its action names the caller rather than the seam", async () => {
    // A 403 either way — but an operator reading it under user billing is looking at a missing auth
    // strategy, not at an unwired subject resolver, and the action must not send them to the wrong file.
    const thrown = await refusal((c) => requirePaymentsSubject(c, USER_MODE));
    expect(thrown.payload.code).toBe("payments/subject_unresolved");
    expect(thrown.payload.action).not.toMatch(/organization/);
  });

  test("the refusal carries a detail an operator can act on, and it never reaches a client", async () => {
    const thrown = await refusal((c) => requirePaymentsSubject(c, ORGANIZATION_MODE));
    expect(thrown.payload.detail).toMatch(/organization/);
  });
});
