// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { renderEmail } from "./engine";
import { catalogLayers, EMAIL_MESSAGES, emailTranslator } from "./messages";
import { templates } from "./registry";
import { samplePayloads } from "./samples";
import { defaultTheme, type EmailTheme } from "./theme";

/**
 * The four account-lifecycle emails (#620): suspended, reinstated, deletion scheduled, deletion complete.
 * Each says what happened, what it means, and who to answer — the sending address, which is the adopter's
 * own. The deletion ones carry the purge date, because a person deciding whether to object needs to know
 * how long they have.
 */

const theme: EmailTheme = { ...defaultTheme, appName: "Acme" };
const LIFECYCLE = ["accountSuspended", "accountReinstated", "deletionScheduled", "deletionComplete"] as const;

describe("the lifecycle templates", () => {
  test("all four are registered, transactional in both axes", () => {
    // Transactional kind: somebody who unsubscribed from a newsletter has not asked to stop being told
    // their account was suspended or is about to be erased. Withholding these would leave a person locked
    // out with no word of why.
    for (const id of LIFECYCLE) {
      expect(templates[id], id).toBeDefined();
      expect(templates[id]?.category, id).toBe("transactional");
      expect(templates[id]?.kind, id).toBe("transactional");
    }
  });

  test("each renders from its sample payload, and its sample satisfies its schema", async () => {
    for (const id of LIFECYCLE) {
      const sample = samplePayloads[id];
      expect(templates[id]?.payload.safeParse(sample).success, id).toBe(true);
      const result = await renderEmail(id, sample, theme);
      expect(result.subject.length, id).toBeGreaterThan(0);
      expect(result.html, id).toContain("</table>");
      expect(result.text.length, id).toBeGreaterThan(0);
    }
  });

  test("a suspension says why, until when, and that a reply reaches somebody", async () => {
    const result = await renderEmail(
      "accountSuspended",
      { name: "Sam", reason: "Chargeback under review.", until: "1 November 2026" },
      theme,
    );
    expect(result.subject).toBe("Your Acme account is suspended");
    for (const part of [result.html, result.text]) {
      expect(part).toContain("Chargeback under review.");
      expect(part).toContain("1 November 2026");
      expect(part).toContain("reply to this email");
    }
  });

  test("a suspension with no reason and no end says neither, rather than printing a blank", async () => {
    const result = await renderEmail("accountSuspended", { name: "Sam" }, theme);
    expect(result.text).not.toContain("The reason given");
    expect(result.text).not.toContain("It ends on");
  });

  test("a reinstatement says the person can sign in again", async () => {
    const result = await renderEmail("accountReinstated", { name: "Sam" }, theme);
    expect(result.text).toContain("You can sign in again.");
  });

  test("a scheduled deletion carries the purge date, and the restore link when there is one", async () => {
    const plain = await renderEmail("deletionScheduled", { purgeOn: "19 November 2026" }, theme);
    for (const part of [plain.html, plain.text]) expect(part).toContain("19 November 2026");
    expect(plain.html).not.toContain("Restore my account");

    const restorable = await renderEmail(
      "deletionScheduled",
      { purgeOn: "19 November 2026", restoreUrl: "https://acme.test/restore" },
      theme,
    );
    expect(restorable.html).toContain("https://acme.test/restore");
    expect(restorable.text).toContain("https://acme.test/restore");
  });

  test("a completed deletion carries the date the data was erased, and says it cannot be undone", async () => {
    const result = await renderEmail("deletionComplete", { purgedOn: "19 November 2026" }, theme);
    for (const part of [result.html, result.text]) {
      expect(part).toContain("19 November 2026");
      expect(part).toContain("cannot be undone");
    }
  });

  test("a reason an operator typed is escaped in the HTML, like every payload value", async () => {
    const result = await renderEmail("accountSuspended", { reason: '<a href="https://evil.test">click</a>' }, theme);
    expect(result.html).not.toContain('<a href="https://evil.test">');
    expect(result.html).toContain("&lt;a href");
  });

  test("each is written in the kit's Spanish too, from the bundled catalog", async () => {
    const t = emailTranslator("es", catalogLayers(EMAIL_MESSAGES));
    for (const id of LIFECYCLE) {
      const english = await renderEmail(id, samplePayloads[id], theme);
      const spanish = await renderEmail(id, samplePayloads[id], theme, undefined, t);
      expect(spanish.subject, id).not.toBe(english.subject);
      expect(spanish.text, id).not.toContain("email/");
    }
  });
});
