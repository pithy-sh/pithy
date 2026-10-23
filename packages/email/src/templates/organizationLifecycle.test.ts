// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { renderEmail } from "./engine";
import { catalogLayers, EMAIL_MESSAGES, emailTranslator } from "./messages";
import { templates } from "./registry";
import { samplePayloads } from "./samples";
import { defaultTheme, type EmailTheme } from "./theme";

/**
 * The three organization-lifecycle notices (#623): an operator suspended an organization, reinstated it, or
 * deleted it with a date its data is erased. Each goes to an owner, names the organization, and says the owner's
 * own account is not what changed.
 */

const theme: EmailTheme = { ...defaultTheme, appName: "Acme" };
const NOTICES = ["organizationSuspended", "organizationReinstated", "organizationDeletionScheduled"] as const;

describe("the organization lifecycle notices", () => {
  test("all three are registered, transactional in both axes", () => {
    for (const id of NOTICES) {
      expect(templates[id], id).toBeDefined();
      expect(templates[id]?.category, id).toBe("transactional");
      expect(templates[id]?.kind, id).toBe("transactional");
    }
  });

  test("each renders from its sample payload, and its sample satisfies its schema", async () => {
    for (const id of NOTICES) {
      const sample = samplePayloads[id];
      expect(templates[id]?.payload.safeParse(sample).success, id).toBe(true);
      const result = await renderEmail(id, sample, theme);
      expect(result.subject, id).toContain("Globex");
      expect(result.html, id).toContain("</table>");
    }
  });

  test("a suspension names the organization, the reason and the end, and says the owner's account is fine", async () => {
    const result = await renderEmail(
      "organizationSuspended",
      { organizationName: "Globex", reason: "Unpaid invoice.", until: "19 November 2026" },
      theme,
    );
    expect(result.subject).toBe("Globex is suspended");
    for (const part of [result.html, result.text]) {
      expect(part).toContain("Unpaid invoice.");
      expect(part).toContain("19 November 2026");
    }
    expect(result.text).toContain("Your own account is not affected.");
  });

  test("a suspension with no reason or end says neither", async () => {
    const result = await renderEmail("organizationSuspended", { organizationName: "Globex" }, theme);
    expect(result.text).not.toContain("The reason given");
    expect(result.text).not.toContain("It ends on");
  });

  test("a deletion names the date its data is erased, twice — once to read, once to act on", async () => {
    const result = await renderEmail(
      "organizationDeletionScheduled",
      { organizationName: "Globex", purgeOn: "19 November 2026" },
      theme,
    );
    expect(result.subject).toBe("Globex is deleted");
    expect(result.text).toContain("erased on 19 November 2026");
    expect(result.text).toContain("before 19 November 2026");
  });

  test("an organization's name and a reason are escaped in the HTML, because a tenant and an operator wrote them", async () => {
    const result = await renderEmail(
      "organizationSuspended",
      { organizationName: '<img src=x onerror="alert(1)">', reason: "<script>x</script>" },
      theme,
    );
    expect(result.html).not.toContain("<img src=x");
    expect(result.html).not.toContain("<script>x");
  });

  test("each is written in the kit's Spanish too, from the bundled catalog", async () => {
    const t = emailTranslator("es", catalogLayers(EMAIL_MESSAGES));
    for (const id of NOTICES) {
      const english = await renderEmail(id, samplePayloads[id], theme);
      const spanish = await renderEmail(id, samplePayloads[id], theme, undefined, t);
      expect(spanish.subject, id).not.toBe(english.subject);
      expect(spanish.text, id).not.toContain("email/");
    }
  });
});
