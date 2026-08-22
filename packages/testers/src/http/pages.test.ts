// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { confirmOptOutPage, page, storePage } from "./pages";

/** Read a rendered page's body. */
async function body(response: Response): Promise<string> {
  return await response.text();
}

describe("every page", () => {
  const rendered = [
    page("Title", "Body"),
    storePage("https://play.google.com/apps/testing/com.acme", "android"),
    confirmOptOutPage("/testers/opt-out/token"),
  ];

  test("is HTML, and says so", async () => {
    for (const response of rendered) {
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    }
  });

  test("is never cached, because every one of them is about one specific tester", async () => {
    // A shared cache holding the store page would serve one tester's link to the next.
    for (const response of rendered) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("the withdrawal page", () => {
  test("renders a form, not a link — following it must take an actor that submits forms", async () => {
    // The reason this page exists. Mail clients prefetch links and security scanners follow them; a
    // one-tap GET would let either withdraw a tester. Withdrawing rotates their token, so that would be
    // irreversible without a fresh invitation.
    const html = await body(confirmOptOutPage("/testers/opt-out/abc"));
    expect(html).toContain('<form method="post" action="/testers/opt-out/abc">');
    expect(html).toContain('<button type="submit"');
  });

  test("asks rather than announces, so somebody who arrived by accident can leave", async () => {
    const html = await body(confirmOptOutPage("/x"));
    expect(html).toContain("Leave the test?");
    expect(html).toContain("Close this page to stay on the test.");
  });

  test("escapes the action, so the URL it is handed cannot break out of the attribute", async () => {
    const html = await body(confirmOptOutPage('/testers/opt-out/"><script>alert(1)</script>'));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("the store page", () => {
  test("names the right store, because the instructions differ per platform", async () => {
    expect(await body(storePage("https://x.test/a", "android"))).toContain("Google Play");
    expect(await body(storePage("https://x.test/a", "ios"))).toContain("TestFlight");
  });

  test("carries both warnings, which are the two ways a tester who did everything right still fails", async () => {
    const html = await body(storePage("https://x.test/a", "android"));
    expect(html).toContain("not inside the Google Play app");
    expect(html).toContain("same address this email reached you at");
  });

  test("prints the URL as text too, for the mail client that strips the button", async () => {
    const html = await body(storePage("https://play.google.com/apps/testing/com.acme", "ios"));
    expect(html.match(/https:\/\/play\.google\.com\/apps\/testing\/com\.acme/g)?.length).toBeGreaterThanOrEqual(2);
  });

  test("escapes the developer-supplied URL in both places it appears", async () => {
    // Host-allowlisted upstream, so this is defense in depth — but it is a developer-supplied string
    // interpolated into an `href` on a page shown to a stranger.
    const html = await body(
      storePage('https://play.google.com/apps/testing/"><img src=x onerror=alert(1)>', "android"),
    );
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&quot;&gt;&lt;img");
  });
});
