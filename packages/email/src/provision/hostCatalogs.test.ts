// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import { emailHostCatalogs } from "./hostCatalogs";

describe("an error's translation is not template copy, and does not ride to the host", () => {
  /**
   * The prefix alone was the filter at first, and the prefix is not the rule this file's own doc
   * states. `email/send_failed` and its five siblings are catalog keys under this capability's domain
   * — for an error the key *is* the code — but no template asks for one, and the host is the Worker
   * that renders templates. A client translates an error from a catalog it already holds.
   *
   * It is 416 bytes of a 5120-byte ceiling a real project already fills to 69%, so it is about 8% of
   * the room a second locale would need.
   */
  const ERROR_CODES = KitErrorPayload.options
    .map((member) => member.shape.code.value)
    .filter((code) => code.startsWith("email/"));

  test("the taxonomy really does put codes under this domain, or the rest of this proves nothing", () => {
    expect(ERROR_CODES.length).toBeGreaterThanOrEqual(6);
  });

  test("no error code reaches the host, even translated", () => {
    const layers = (locale: string) => [
      locale === "es" ? Object.fromEntries(ERROR_CODES.map((code) => [code, `es: ${code}`])) : undefined,
      { "email/magic_link.subject": locale === "es" ? "Tu enlace" : "Your link" },
    ];
    const carried = emailHostCatalogs(["es"], layers);
    for (const code of ERROR_CODES) {
      expect(carried.es?.[code], code).toBeUndefined();
    }
    // And the template copy beside them still does, so the filter is a cut and not a wall.
    expect(carried.es?.["email/magic_link.subject"]).toBe("Tu enlace");
  });
});
