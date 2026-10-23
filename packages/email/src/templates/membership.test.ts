// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { renderEmail } from "./engine";
import { catalogLayers, EMAIL_MESSAGES, emailTranslator } from "./messages";
import { templates } from "./registry";
import { samplePayloads } from "./samples";
import { defaultTheme, type EmailTheme } from "./theme";

/**
 * The three membership notices (#624): an operator added somebody, removed somebody, or made somebody the
 * owner. Each names the organization, says what changed, and says who to answer.
 */

const theme: EmailTheme = { ...defaultTheme, appName: "Acme" };
const MEMBERSHIP = [
  "organizationMemberAdded",
  "organizationMemberRemoved",
  "organizationOwnershipTransferred",
] as const;

describe("the membership notices", () => {
  test("all three are registered, transactional in both axes", () => {
    // Somebody whose access to an account was changed by somebody else is owed the word, and an
    // unsubscribe from a newsletter is not a request to stop being told.
    for (const id of MEMBERSHIP) {
      expect(templates[id], id).toBeDefined();
      expect(templates[id]?.category, id).toBe("transactional");
      expect(templates[id]?.kind, id).toBe("transactional");
    }
  });

  test("each renders from its sample payload, and its sample satisfies its schema", async () => {
    for (const id of MEMBERSHIP) {
      const sample = samplePayloads[id];
      expect(templates[id]?.payload.safeParse(sample).success, id).toBe(true);
      const result = await renderEmail(id, sample, theme);
      expect(result.subject, id).toContain("Globex");
      expect(result.html, id).toContain("</table>");
      expect(result.text, id).toContain("reply to this email");
    }
  });

  test("an add names the organization and the role", async () => {
    const result = await renderEmail(
      "organizationMemberAdded",
      { name: "Sam", organizationName: "Globex", role: "admin" },
      theme,
    );
    expect(result.subject).toBe("You were added to Globex");
    for (const part of [result.html, result.text]) {
      expect(part).toContain("Globex");
      expect(part).toContain("as admin");
    }
  });

  test("a removal says the person can no longer act in it", async () => {
    const result = await renderEmail("organizationMemberRemoved", { organizationName: "Globex" }, theme);
    expect(result.subject).toBe("You were removed from Globex");
    expect(result.text).toContain("You can no longer act in it.");
  });

  test("a transfer tells the new owner", async () => {
    const result = await renderEmail("organizationOwnershipTransferred", { organizationName: "Globex" }, theme);
    expect(result.subject).toBe("You now own Globex");
    expect(result.text).toContain("you answer for it");
  });

  test("an organization's name is escaped in the HTML, because a tenant chose it", async () => {
    const result = await renderEmail(
      "organizationMemberRemoved",
      { organizationName: '<img src=x onerror="alert(1)">' },
      theme,
    );
    expect(result.html).not.toContain("<img src=x");
    expect(result.html).toContain("&lt;img");
  });

  test("each is written in the kit's Spanish too, from the bundled catalog", async () => {
    const t = emailTranslator("es", catalogLayers(EMAIL_MESSAGES));
    for (const id of MEMBERSHIP) {
      const english = await renderEmail(id, samplePayloads[id], theme);
      const spanish = await renderEmail(id, samplePayloads[id], theme, undefined, t);
      expect(spanish.subject, id).not.toBe(english.subject);
      expect(spanish.text, id).not.toContain("email/");
    }
  });
});
