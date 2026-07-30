// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { type RenderTracking, renderEmail } from "../templates/engine";
import { defaultTheme } from "../templates/theme";

/**
 * LIVE integration test — sends real email through the Cloudflare Email Service from the `pithy.sh`
 * apex sending domain. It renders with the real engine and posts to the Email Sending REST API (the
 * `send_email` binding only runs inside a Worker, so a node integration test uses REST — the delivery
 * path and the rendered payload are the same). Recipient is `jim+<x>@pithy.sh`, which the operator
 * provided for testing. Bounce *binding* is intentionally out of scope. Sending requires an API token
 * with the **Email Sending: Edit** permission; a general account token authenticates but the send
 * endpoint rejects it (code 10000). So this is gated behind `PITHY_EMAIL_LIVE=1` *and* the live
 * credentials — set the flag only with an email-scoped token. Skipped by default.
 */

const here = dirname(fileURLToPath(import.meta.url));
// Defaults target the `pithy.sh` apex sender; override with PITHY_EMAIL_FROM for another onboarded domain.
const FROM = { address: process.env.PITHY_EMAIL_FROM ?? "noreply@pithy.sh", name: "Pithy" };
const TO = process.env.PITHY_EMAIL_TO ?? "jim+pithytest@pithy.sh";

/** Read `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` from `.dev.vars`, searching upward. */
function loadCfCreds(): { accountId: string; apiToken: string } | null {
  let dir = join(here, "..", "..");
  for (;;) {
    const file = join(dir, ".dev.vars");
    if (existsSync(file)) {
      const vars: Record<string, string> = {};
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        // Strip surrounding quotes — dotenv values are commonly wrapped.
        if (match?.[1] && match[2] !== undefined) vars[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
      }
      const accountId = vars.CLOUDFLARE_ACCOUNT_ID;
      const apiToken = vars.CLOUDFLARE_API_TOKEN;
      return accountId && apiToken ? { accountId, apiToken } : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

interface SendResult {
  success: boolean;
  errors: { code: number; message: string }[];
  result: { message_id?: string; delivered?: string[]; queued?: string[]; permanent_bounces?: string[] } | null;
}

/** Post a rendered email to the Email Sending REST API. */
async function send(
  creds: { accountId: string; apiToken: string },
  rendered: { subject: string; html: string; text: string },
): Promise<SendResult> {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/email/sending/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
    body: JSON.stringify({ to: TO, from: FROM, subject: rendered.subject, html: rendered.html, text: rendered.text }),
  });
  return (await res.json()) as SendResult;
}

const creds = loadCfCreds();
const enabled = Boolean(creds) && process.env.PITHY_EMAIL_LIVE === "1";
const theme = { ...defaultTheme, appName: "Pithy", footerAddress: "Pithy · San Francisco, CA" };
const tracking: RenderTracking = {
  baseUrl: "https://api.pithy.sh",
  jobId: "live-int",
  recipient: TO,
  key: "live-integration-signing-key",
  kid: "1",
  expiresAt: new Date("2099-01-01T00:00:00Z"),
  openTracking: true,
  clickTracking: true,
};

describe.skipIf(!enabled)("Cloudflare Email Service — LIVE send via pithy.sh", () => {
  test("delivers a transactional magic-link email", async () => {
    if (!creds) return;
    const rendered = await renderEmail(
      "magicLink",
      { name: "Jim", url: "https://pithy.sh/signin?t=demo", expiresMinutes: 15 },
      theme,
    );
    const result = await send(creds, rendered);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    // The API accepts then delivers asynchronously: a message id means accepted.
    expect(result.result?.message_id).toBeTruthy();
  });

  test("delivers a marketing newsletter with tracked links + unsubscribe", async () => {
    if (!creds) return;
    const rendered = await renderEmail(
      "newsletter",
      {
        subject: "Pithy — live integration test",
        intro: "This is a live send from the @pithy-sh/email integration suite.",
        articles: [
          {
            title: "Durable sends",
            summary: "Every email is a job: scheduled, retried, tracked.",
            link: "https://pithy.sh/docs/email",
          },
          {
            title: "Themeable",
            summary: "Light/dark presets, plug your colors in.",
            link: "https://pithy.sh/docs/email#themes",
          },
        ],
        outro: "That's it.",
      },
      theme,
      tracking,
    );
    expect(rendered.html).toContain("/_pithy/email/u/"); // unsubscribe forced for marketing
    const result = await send(creds, rendered);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });
});
