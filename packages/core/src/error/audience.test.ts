// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { defineErrorPayload } from "./extend";
import { HttpError, pithyErrorHandler } from "./http";
import { KitPublicErrorPayload, PublicErrorPayload } from "./payload";
import { InternalError, NotFoundError } from "./pithyError";

/**
 * `action` is an operator remedy, and the wire is not an operator surface.
 *
 * The census that settled it: of the ~600 `action` values the kit ships, all but a handful name a
 * `pithy` command, a file in the adopter's repo, a wrangler binding, or a provider console —
 * `Run \`pithy vector provision\``, `Bind a D1 database named DB in wrangler.jsonc`, `Set \`name\` in
 * pithy.config.ts`. That is a sentence for somebody with the project checked out. Sent to a browser it
 * is a description of the deployment, and it was travelling in the one field nobody had classified.
 *
 * So the audience is the operator, and the boundary is the one already written: `action` sits beside
 * `detail` on `ErrorPayload` and is absent from `PublicErrorPayload`. A caller remedy has a field of
 * its own and always did — `message`, the field whose whole definition is "safe to expose".
 *
 * Enforced at the schema rather than at the throw site, because a throw site is where this codebase
 * has repeatedly fixed one instance and left its siblings. There is nothing for a throw site to get
 * right: the wire shape has no such key.
 */

/** The minimum valid instance of one wire member, built from its own literals. */
function wireInstanceOf(member: (typeof KitPublicErrorPayload.options)[number]): Record<string, unknown> {
  const instance: Record<string, unknown> = {
    code: member.shape.code.value,
    status: member.shape.status.value,
    message: "Public wording.",
  };
  if ("issues" in member.shape) instance.issues = [];
  return instance;
}

/** An operator remedy of the shape the census found: a command, a file, a binding. */
const OPERATOR_REMEDY = "Run `pithy secrets set payments-provider` with the token from vendor.example.com.";

describe("`action` is operator-facing, and the wire union has no field for it", () => {
  // The whole population, not a sample: every member `PublicErrorPayload` can validate a body against.
  test.each(KitPublicErrorPayload.options.map((member) => [member.shape.code.value, member] as const))(
    "%s drops an `action` on parse",
    (_code, member) => {
      const parsed = member.parse({ ...wireInstanceOf(member), action: OPERATOR_REMEDY });
      expect(Object.hasOwn(parsed, "action")).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("pithy secrets set");
    },
  );

  test("the adopter's open member drops it too — the seam does not widen the audience", () => {
    const wire = PublicErrorPayload.parse({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
      action: OPERATOR_REMEDY,
    });
    expect(Object.hasOwn(wire, "action")).toBe(false);
  });
});

describe("no operator remedy reaches a browser", () => {
  test("the codec encodes a kit error without its remedy", () => {
    const wire = HttpError.encode(new NotFoundError({ action: OPERATOR_REMEDY, detail: "row 5" }).payload);
    expect(wire).toEqual({ code: "core/not_found", status: 404, message: "Not found." });
  });

  test("the codec encodes an adopter error without its remedy", () => {
    const wire = HttpError.encode(
      defineErrorPayload({
        code: "connect/device_code_expired",
        status: 410,
        message: "That device code has expired.",
        action: "Run pithy dashboard connect again.",
        detail: "code 9f2c bound to org 3",
      }),
    );
    expect(wire).toEqual({
      code: "connect/device_code_expired",
      status: 410,
      message: "That device code has expired.",
    });
  });

  test("a real request never sees it — the response body carries neither the key nor the sentence", async () => {
    const app = new Hono();
    app.onError(pithyErrorHandler);
    app.get("/thing", () => {
      throw new InternalError({
        message: "Something went wrong.",
        action: OPERATOR_REMEDY,
        detail: "KV namespace PITHY_SECRETS unbound on pithy-prod",
      });
    });

    const response = await app.request("/thing");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain("pithy secrets set");
    expect(body).not.toContain("vendor.example.com");
    expect(body).not.toContain("PITHY_SECRETS");
    expect(JSON.parse(body)).toEqual({
      error: { code: "core/internal", status: 500, message: "Something went wrong." },
    });
  });
});
