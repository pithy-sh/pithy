// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { sendMagicLink } from "@pithy-sh/auth/src/client/api";
import { type LiveApp, resetLiveSecrets, startLiveApp } from "@pithy-sh/auth/src/test-utils/liveApp";
import { decodingsHolding } from "@pithy-sh/core/src/test-utils/urlDecodings";
import { CALLBACK_BASE, listTemplates, renderEmail } from "@pithy-sh/email/src/templates/engine";
import { samplePayloads } from "@pithy-sh/email/src/templates/samples";
import { defaultTheme } from "@pithy-sh/email/src/templates/theme";
import { mintInvitationToken } from "@pithy-sh/organization/src/invite/token";
import { invitationAcceptUrl } from "@pithy-sh/organization/src/mail/invitation";
import { confirmUrl, optInUrl, optOutUrl, TestersConfig } from "@pithy-sh/testers/src/config/config";
import { generateOptInToken } from "@pithy-sh/testers/src/crypto/token";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * **No link the kit mails names the person it is mailed to.**
 *
 * A link is written to every request log between a mail client and the Worker the moment it is followed or
 * prefetched: Cloudflare's, Workers observability and tail, a mail scanner, a proxy. So each producer below mints
 * a link for one address, and the test decodes it every way a reader of that log could (`urlDecodings`: raw,
 * URL-decoded, each segment as base64 and base64url) and asserts none of them holds the address.
 *
 * The producers are every link the kit puts in a message: the email capability's click, open-pixel and
 * unsubscribe links (and the `List-Unsubscribe` header, which is the same URL) over every template, the auth
 * magic link as Better Auth mints it, an organization invitation's accept link, and the testers capability's
 * confirm, store opt-in and opt-out links. A new kind of mailed link joins this list in the change that adds it.
 * The scaffolded code screen holds its address outside the URL; its own tests say so, in both template sets.
 */

const ADDRESS = "Ada.Lovelace+links@example.test";

/** Every absolute URL in a rendered message. */
function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((match) => match[0].replace(/&amp;/g, "&"));
}

describe("the email capability's tracked links", () => {
  test.each(listTemplates().map((template) => template.id))(
    "%s mints no link that decodes to its recipient",
    async (id) => {
      const rendered = await renderEmail(
        id,
        samplePayloads[id],
        { ...defaultTheme, appName: "Acme" },
        {
          baseUrl: "https://api.acme.test",
          jobId: "job-links",
          recipient: ADDRESS,
          campaignId: "spring",
          key: "link-signing-key",
          kid: "1",
          expiresAt: new Date("2099-01-01T00:00:00Z"),
          openTracking: true,
          clickTracking: true,
        },
      );
      const every = [...urlsIn(rendered.html), ...urlsIn(rendered.text), rendered.unsubscribeUrl ?? ""].filter(Boolean);
      const tracked = every.filter((url) => url.includes(CALLBACK_BASE));
      expect(tracked.length, `${id} rendered no tracked link at all, so this case proves nothing`).toBeGreaterThan(0);
      // Every link in the message, tracked or not: the address must reach no URL a client will fetch.
      for (const url of every) expect(decodingsHolding(url, ADDRESS), url).toEqual([]);
    },
  );
});

describe("the auth magic link", () => {
  let app: LiveApp;

  beforeAll(async () => {
    app = await startLiveApp({ basePath: "/auth" });
  });

  afterAll(async () => {
    await app?.close();
    resetLiveSecrets();
  });

  test("as Better Auth mints it, decodes to no address", async () => {
    const address = "magic.link@example.test";
    const sent = await sendMagicLink(
      { email: address, callbackURL: "/callback" },
      {
        basePath: "/auth",
        fetch: (path, init) =>
          fetch(`${app.origin}${path}`, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: app.origin },
          }),
      },
    );
    expect(sent.ok).toBe(true);
    const row = await app.db
      .prepare("select payload from pithy_email_jobs where template = 'magicLink' order by rowid desc limit 1")
      .first<{ payload: string }>();
    const url = (JSON.parse(row?.payload ?? "{}") as { url?: string }).url ?? "";
    expect(url).toContain("/auth/");
    expect(decodingsHolding(url, address)).toEqual([]);
  }, 60_000);
});

describe("the organization and testers links", () => {
  test("an invitation's accept link decodes to no address", () => {
    const url = invitationAcceptUrl(
      { baseUrl: "https://app.acme.test", invitationAcceptPath: "/invitations" },
      mintInvitationToken(),
    );
    expect(decodingsHolding(url, ADDRESS)).toEqual([]);
  });

  test("a tester's confirm, opt-in and opt-out links decode to no address", () => {
    const config = TestersConfig.parse({ baseUrl: "https://api.acme.test" });
    const token = generateOptInToken();
    for (const url of [confirmUrl(config, token), optInUrl(config, token), optOutUrl(config, token)]) {
      expect(decodingsHolding(url, ADDRESS), url).toEqual([]);
    }
  });
});

describe("the decoder the gate reads with", () => {
  test("finds an address however a URL hides it: raw, escaped, base64 or base64url, at any alignment", () => {
    const b64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const url of [
      `https://x.test/u?email=${ADDRESS}`,
      `https://x.test/u?email=${encodeURIComponent(ADDRESS)}`,
      `https://x.test/u/${b64url(JSON.stringify({ recipient: ADDRESS }))}.sig`,
      `https://x.test/u/${btoa(`xx${ADDRESS}`)}`,
      `https://x.test/u/${encodeURIComponent(btoa(ADDRESS))}`,
      `https://x.test/u/${ADDRESS.replace("@", "%40")}`,
      `https://x.test/u?d=${encodeURIComponent(JSON.stringify(ADDRESS).replace("@", "\\u0040"))}`,
      `https://x.test/u/${[...ADDRESS].map((char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`,
    ]) {
      expect(decodingsHolding(url, ADDRESS), url).not.toEqual([]);
    }
  });
});
