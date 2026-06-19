import { env } from "cloudflare:test";
import { beforeEach, describe, expect, test } from "vitest";
import { mintToken, type TokenClaims } from "../crypto/token";
import { emailDatabase, emailSuppressionDatabase } from "../data/tables";
import { email_0001_init } from "../migrations/0001_init";
import { email_0001_suppressions } from "../migrations/0001_suppressions";
import { handleClick, handleOpen, handleUnsubscribe, type SigningKeys } from "./callbacks";

const KEY = "callback-signing-key";
const keys: SigningKeys = { versions: { "1": KEY } };
const now = new Date("2026-06-18T12:00:00.000Z");
const expiresAt = new Date("2026-12-18T12:00:00.000Z");

function token(claims: TokenClaims): Promise<string> {
  return mintToken(claims, { key: KEY, kid: "1", expiresAt });
}

async function eventsFor(jobId: string): Promise<{ type: string; recipient: string; link_url: string | null }[]> {
  const rows = await env.DB.prepare(
    "select type, recipient, link_url from pithy_email_events where job_id = ? order by id",
  )
    .bind(jobId)
    .all<{ type: string; recipient: string; link_url: string | null }>();
  return rows.results;
}

beforeEach(async () => {
  for (const table of ["pithy_email_jobs", "pithy_email_events"]) {
    await env.DB.prepare(`drop table if exists ${table}`).run();
  }
  await env.EMAIL_SUPPRESSIONS.prepare("drop table if exists pithy_email_suppressions").run();
  await email_0001_init.up(emailDatabase(env.DB));
  await email_0001_suppressions.up(emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS));
});

describe("click callback", () => {
  test("records the click and 302-redirects to the signed destination", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-1",
      recipient: "U@Example.com",
      destination: "https://acme.test/welcome",
      linkLabel: "cta",
      campaignId: "spring",
    });
    const res = await handleClick(emailDatabase(env.DB), keys, t, now);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://acme.test/welcome");
    expect(await eventsFor("job-1")).toEqual([
      { type: "click", recipient: "u@example.com", link_url: "https://acme.test/welcome" },
    ]);
  });

  test("rejects a forged token before recording anything", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-2",
      recipient: "u@example.com",
      destination: "https://acme.test/x",
    });
    const forged = `${t}tamper`;
    await expect(handleClick(emailDatabase(env.DB), keys, forged, now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
    expect(await eventsFor("job-2")).toEqual([]);
  });

  test("refuses a non-http destination (no open redirect)", async () => {
    const t = await token({
      kind: "click",
      jobId: "job-3",
      recipient: "u@example.com",
      destination: "javascript:alert(1)",
    });
    await expect(handleClick(emailDatabase(env.DB), keys, t, now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });

  test("rejects a token minted for a different callback kind", async () => {
    const t = await token({ kind: "open", jobId: "job-4", recipient: "u@example.com" });
    await expect(handleClick(emailDatabase(env.DB), keys, t, now)).rejects.toMatchObject({
      payload: { code: "email/invalid_token" },
    });
  });
});

describe("open callback", () => {
  test("records the open and returns a PNG pixel, tolerating the .png suffix", async () => {
    const t = await token({ kind: "open", jobId: "job-5", recipient: "u@example.com", campaignId: "spring" });
    const res = await handleOpen(emailDatabase(env.DB), keys, `${t}.png`, now);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect((await eventsFor("job-5"))[0]).toMatchObject({ type: "open", recipient: "u@example.com" });
  });
});

describe("unsubscribe callback", () => {
  test("suppresses the address, records the opt-out, and confirms", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-6", recipient: "Bye@Example.com", campaignId: "spring" });
    const res = await handleUnsubscribe(
      emailDatabase(env.DB),
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      keys,
      t,
      now,
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("unsubscribed");
    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select reason from pithy_email_suppressions where email = ?")
      .bind("bye@example.com")
      .first<{ reason: string }>();
    expect(sup?.reason).toBe("unsubscribe");
    expect((await eventsFor("job-6"))[0]).toMatchObject({ type: "unsubscribe", recipient: "bye@example.com" });
  });

  test("stores a caller-supplied reason on the suppression detail", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-r", recipient: "r@example.com" });
    await handleUnsubscribe(
      emailDatabase(env.DB),
      emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS),
      keys,
      t,
      now,
      "too_many_emails",
    );

    const sup = await env.EMAIL_SUPPRESSIONS.prepare("select detail from pithy_email_suppressions where email = ?")
      .bind("r@example.com")
      .first<{ detail: string }>();
    expect(sup?.detail).toBe("too_many_emails");
  });

  test("an expired token is rejected and suppresses nothing", async () => {
    const t = await token({ kind: "unsubscribe", jobId: "job-7", recipient: "u@example.com" });
    const afterExpiry = new Date("2027-01-01T00:00:00.000Z");
    await expect(
      handleUnsubscribe(emailDatabase(env.DB), emailSuppressionDatabase(env.EMAIL_SUPPRESSIONS), keys, t, afterExpiry),
    ).rejects.toMatchObject({ payload: { code: "email/invalid_token" } });
    const count = await env.EMAIL_SUPPRESSIONS.prepare("select count(*) as n from pithy_email_suppressions").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });
});
