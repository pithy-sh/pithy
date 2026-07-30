// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { verifyToken } from "../crypto/token";
import { CALLBACK_BASE, listTemplates, renderEmail } from "./engine";
import { templates } from "./registry";
import { defaultTheme, type EmailTheme } from "./theme";

const theme: EmailTheme = { ...defaultTheme, appName: "Acme", footerAddress: "1 Market St, SF" };

const tracking = {
  baseUrl: "https://api.acme.test/",
  jobId: "job-9",
  recipient: "u@example.com",
  campaignId: "spring",
  key: "signing-key",
  kid: "1",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  openTracking: true,
  clickTracking: true,
};

const validPayloads: Record<string, unknown> = {
  magicLink: { url: "https://acme.test/signin?t=abc", expiresMinutes: 15 },
  otp: { code: "123456", expiresMinutes: 10 },
  welcome: { name: "Sam", ctaUrl: "https://acme.test/start", ctaLabel: "Get started" },
  securityAlert: { event: "New sign-in", when: "today", actionUrl: "https://acme.test/activity" },
  invite: { inviterName: "Pat", organizationName: "Acme", acceptUrl: "https://acme.test/accept" },
  passwordChanged: { when: "today", supportUrl: "https://acme.test/support" },
  newsletter: {
    subject: "Acme Weekly",
    intro: "This week:",
    articles: [
      { title: "A", summary: "sa", link: "https://acme.test/a" },
      { title: "B", summary: "sb", link: "https://acme.test/b" },
    ],
  },
  leadCapture: { assetName: "Playbook", assetUrl: "https://acme.test/dl" },
  marketingCampaign: {
    subject: "Big news",
    heading: "Hello",
    body: "Body copy.",
    ctaUrl: "https://acme.test/go",
    ctaLabel: "See it",
  },
};

describe("template registry", () => {
  test("ships all nine templates from the acceptance criteria", () => {
    expect(
      listTemplates()
        .map((t) => t.id)
        .sort(),
    ).toEqual(
      [
        "invite",
        "leadCapture",
        "magicLink",
        "marketingCampaign",
        "newsletter",
        "otp",
        "passwordChanged",
        "securityAlert",
        "welcome",
      ].sort(),
    );
  });

  test("every template renders subject/html/text with a valid payload", async () => {
    for (const [id, payload] of Object.entries(validPayloads)) {
      const isMarketing = templates[id]?.category === "marketing";
      const result = await renderEmail(id, payload, theme, isMarketing ? tracking : undefined);
      expect(result.subject.length).toBeGreaterThan(0);
      expect(result.html).toContain("</table>");
      expect(result.text.length).toBeGreaterThan(0);
    }
  });
});

describe("payload validation", () => {
  test("an unknown template throws template_not_found", async () => {
    await expect(renderEmail("nope", {}, theme)).rejects.toMatchObject({
      payload: { code: "email/template_not_found" },
    });
  });

  test("a missing required field throws invalid_payload", async () => {
    await expect(renderEmail("welcome", { name: "Sam" }, theme)).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });
});

describe("tracking", () => {
  test("transactional with no tracking leaves links direct and adds no pixel or unsubscribe", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme);
    expect(result.html).toContain("https://acme.test/start");
    expect(result.html).not.toContain(`${CALLBACK_BASE}/c/`);
    expect(result.html).not.toContain(`${CALLBACK_BASE}/o/`);
    expect(result.html).not.toContain("Unsubscribe");
  });

  test("click tracking rewrites the CTA to a signed callback that carries the destination", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme, { ...tracking });
    const match = result.html.match(/\/_pithy\/email\/c\/([A-Za-z0-9_.-]+)/);
    expect(match).not.toBeNull();
    const claims = await verifyToken(match?.[1] ?? "", { versions: { "1": tracking.key } }, new Date());
    expect(claims).toMatchObject({
      kind: "click",
      destination: "https://acme.test/start",
      linkLabel: "welcome-cta",
      jobId: "job-9",
    });
  });

  test("open tracking injects a one-by-one pixel", async () => {
    const result = await renderEmail("welcome", validPayloads.welcome, theme, { ...tracking });
    expect(result.html).toMatch(/\/_pithy\/email\/o\/[A-Za-z0-9_.-]+\.png/);
  });

  test("a marketing template forces an unsubscribe link", async () => {
    const result = await renderEmail("marketingCampaign", validPayloads.marketingCampaign, theme, { ...tracking });
    expect(result.html).toContain("Unsubscribe");
    expect(result.html).toMatch(/\/_pithy\/email\/u\//);
  });

  test("a marketing template cannot render without tracking context", async () => {
    await expect(renderEmail("newsletter", validPayloads.newsletter, theme)).rejects.toMatchObject({
      payload: { code: "email/invalid_payload" },
    });
  });

  test("each newsletter article link is rewritten independently", async () => {
    const result = await renderEmail("newsletter", validPayloads.newsletter, theme, { ...tracking });
    const clicks = [...result.html.matchAll(/\/_pithy\/email\/c\/([A-Za-z0-9_.-]+)/g)];
    expect(clicks.length).toBe(2);
    const labels = await Promise.all(
      clicks.map(
        async (m) => (await verifyToken(m[1] ?? "", { versions: { "1": tracking.key } }, new Date())).linkLabel,
      ),
    );
    expect(labels.sort()).toEqual(["newsletter-article-0", "newsletter-article-1"]);
  });
});
