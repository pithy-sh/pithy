// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { clientError } from "./client";
import { defineErrorPayload } from "./extend";
import { ErrorPayload, KitErrorPayload } from "./payload";
import { NotFoundError } from "./pithyError";

/**
 * `clientError` is the projection every client transport goes through. #344 classified `action` as the
 * operator's and put the strip in the HTTP codec; the socket in `@pithy-sh/multiplayer` was a second
 * transport, with a second hand-written projection, and it sent the remedy on. So the rule moved above
 * the transports and the transports call it. These are the tests of the rule itself — the socket's own
 * end-to-end proof lives in `packages/multiplayer/src/session/websocket.workers.test.ts`.
 */

/** An operator remedy of the shape the #344 census found: a command, a file, a binding. */
const OPERATOR_REMEDY = "Run `pithy secrets set payments-provider`, then redeploy the Worker.";
const THROW_SITE_CONTEXT = "KV namespace PITHY_SECRETS unbound on pithy-prod";

/** A full in-memory payload for one kit member, built from its own literals plus both operator fields. */
function payloadOf(member: (typeof KitErrorPayload.options)[number]): ErrorPayload {
  const instance: Record<string, unknown> = {
    code: member.shape.code.value,
    status: member.shape.status.value,
    message: "Public wording.",
    action: OPERATOR_REMEDY,
    detail: THROW_SITE_CONTEXT,
  };
  if ("issues" in member.shape) instance.issues = [];
  return ErrorPayload.parse(instance);
}

describe("clientError — the one projection toward a client", () => {
  // The whole population, not a sample. A code added to the kit is covered the day it lands.
  test.each(KitErrorPayload.options.map((member) => [member.shape.code.value, member] as const))(
    "%s reaches a client without the operator's fields",
    (_code, member) => {
      const wire = clientError(payloadOf(member));
      expect(Object.hasOwn(wire, "action")).toBe(false);
      expect(Object.hasOwn(wire, "detail")).toBe(false);
      // The bytes, because a key is only half of it — neither sentence may appear under any name.
      const serialized = JSON.stringify(wire);
      expect(serialized).not.toContain("pithy secrets set");
      expect(serialized).not.toContain("PITHY_SECRETS");
    },
  );

  test("an adopter's own code is held to it too — the open member does not widen the audience", () => {
    const wire = clientError(
      defineErrorPayload({
        code: "connect/device_code_expired",
        status: 410,
        message: "That device code has expired.",
        action: "Run `pithy dashboard connect` again from the project directory.",
        detail: "code 9f2c bound to org 3",
      }),
    );
    expect(wire).toEqual({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
    });
  });

  test("what a client does need survives — the public fields are untouched", () => {
    expect(clientError(new NotFoundError({ message: "No such session.", action: OPERATOR_REMEDY }).payload)).toEqual({
      code: "core/not_found",
      status: 404,
      message: "No such session.",
    });
  });
});

/**
 * **Why there is no "both transports agree" test here, though one is the obvious thing to write.**
 *
 * It was written, and it could not fail. `HttpError.encode` is a `z.codec`, so Zod validates whatever the
 * encoder returns against `PublicErrorPayload` — give the codec back its own hand-written strip that keeps
 * `action`, and the schema removes it anyway, and the comparison stays green. A gate that passes on the
 * mutation it names is worse than none: it reports a boundary it is not holding.
 *
 * The schema is the HTTP surface's second line, and it is genuinely there. What has no second line is a
 * transport that serialises by hand and never parses — which is exactly what the socket did. So that
 * transport is gated where it can fail: end-to-end, over a real socket, in
 * `packages/multiplayer/src/session/websocket.workers.test.ts`. The next transport needs its own, for the
 * same reason.
 */
