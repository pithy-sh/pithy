import { describe, expect, test } from "vitest";
import { renderEmail } from "./engine";
import { defaultTheme, type EmailTheme } from "./theme";

/**
 * The render engine compiles Handlebars templates at module load. This proves that compilation and
 * rendering work inside the actual Workers runtime (workerd via Miniflare) — the runtime that forbids
 * dynamic evaluation at request time — so "precompiled at startup, no compile per send" holds in
 * production, not just under Node.
 */

const theme: EmailTheme = {
  ...defaultTheme,
  appName: "Acme",
  logoUrl: "https://cdn.acme.test/logo.png",
  footerAddress: "1 Market St",
};

describe("template engine under the Workers runtime", () => {
  test("renders a transactional template (narrow) with the theme applied", async () => {
    const result = await renderEmail(
      "welcome",
      { name: "Sam", ctaUrl: "https://acme.test/start", ctaLabel: "Open" },
      theme,
    );
    expect(result.subject).toBe("Welcome to Acme");
    expect(result.html).toContain("https://cdn.acme.test/logo.png");
    expect(result.html).toContain("max-width: 600px"); // welcome is narrow per its template
    expect(result.text).toContain("Welcome to Acme");
  });

  test("renders the newsletter at the wide width its template declares", async () => {
    const result = await renderEmail(
      "newsletter",
      { subject: "Weekly", intro: "Hi", articles: [{ title: "A", summary: "s", link: "https://acme.test/a" }] },
      theme,
      {
        baseUrl: "https://api.acme.test",
        jobId: "j",
        recipient: "u@example.com",
        key: "k",
        kid: "1",
        expiresAt: new Date("2099-01-01T00:00:00Z"),
        openTracking: false,
        clickTracking: false,
      },
    );
    expect(result.html).toContain("max-width: 720px");
  });
});
