// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { KitErrorPayload } from "@pithy-sh/core/src/error/payload";
import { describe, expect, test } from "vitest";
import { EMAIL_MESSAGES, type EmailMessageLayers } from "../templates/messages";
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

describe("the host is built with the kit's words, not sent them", () => {
  /**
   * **The whole of #442, stated as the property an adopter feels.**
   *
   * The send Worker is a separate deploy with no request and no access to `pithy.config.ts`, so
   * anything it does not bundle has to be stamped into it as configuration. Holding the kit's own
   * translations in `@pithy-sh/i18n` meant static data traveled that channel on every provision run,
   * against a 5 KB per-variable ceiling one language pack filled to 61%. Held beside the English they
   * translate, the host is built with them and the variable carries only what an adopter changed.
   */
  // Typed as the seam it stands in for, rather than passed `as never`. These cases rest entirely on
  // this helper answering the layers `catalogLayers` would, and `as never` turns off the one check
  // that says so.
  const kit: EmailMessageLayers = (locale) => [EMAIL_MESSAGES[locale], EMAIL_MESSAGES.en];

  test("a project on the kit's own locales, overriding nothing, deploys no variable at all", () => {
    expect(emailHostCatalogs(["en", "es"], kit)).toEqual({});
  });

  test("adding a locale the kit ships costs no configuration growth", () => {
    // The property that makes adding languages free: this is the same empty answer whether the
    // project serves one language or every language the kit is written in.
    expect(emailHostCatalogs(["en"], kit)).toEqual({});
    expect(emailHostCatalogs(["en", "es"], kit)).toEqual({});
  });

  test("an adopter overriding one sentence deploys one sentence", () => {
    const overridden: EmailMessageLayers = (locale) =>
      locale === "es" ? [{ "email/shell.unsubscribe": "Baja" }, ...kit("es")] : kit(locale);
    const carried = emailHostCatalogs(["en", "es"], overridden);
    expect(carried).toEqual({ es: { "email/shell.unsubscribe": "Baja" } });
    expect(new TextEncoder().encode(JSON.stringify(carried.es)).length).toBeLessThan(100);
  });

  test("a locale the kit does not ship still travels whole, because nothing bundled it", () => {
    // The other half of the rule: what the host was not built with, it must still be told.
    const french: EmailMessageLayers = (locale) =>
      locale === "fr" ? [{ "email/shell.unsubscribe": "Se désabonner" }, ...kit("fr")] : kit(locale);
    expect(emailHostCatalogs(["en", "fr"], french)).toEqual({
      fr: { "email/shell.unsubscribe": "Se désabonner" },
    });
  });
});
