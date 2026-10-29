// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CloudflareClients } from "@pithy-sh/cloudflare/src/client/clients";
import { fixtureReady } from "@pithy-sh/cloudflare/src/test-utils/fixtures";
import {
  INTEGRATION_COMPATIBILITY_DATE,
  loadIntegrationCreds,
  uniqueName,
} from "@pithy-sh/cloudflare/src/test-utils/harness";
import { reapArtifactsNamespace } from "@pithy-sh/cloudflare/src/test-utils/reap";
import { waitForStable } from "@pithy-sh/cloudflare/src/test-utils/settle";
import { readWorkerAnswer } from "@pithy-sh/cloudflare/src/test-utils/workerAnswer";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";

/**
 * LIVE — revoking every token reaches past the first page of `listTokens()`.
 *
 * ## The question
 *
 * `revokeEveryToken` is the break-glass after a leak. The binding's `listTokens()` answers one page with no cursor,
 * and its documentation names no filter, page size or order. If the listing keeps revoked tokens on its page, a
 * list-and-revoke loop asks for the same first page again, finds it dead, and stops with live tokens past it while
 * the route answers success. The workers tests cannot tell, because their stand-in answers whatever it was written
 * to answer. Only the real binding can, and the binding exists only inside a Worker.
 *
 * ## How it is asked
 *
 * The suite bundles a small Worker around the kit's own `revokeEveryToken`, uploads it bound to a throwaway
 * namespace, and drives it over `workers.dev`. It mints until a listing shows fewer tokens than its `total`, which is
 * the first page boundary, and records what the listing answered: which states, how many a page, in what order. Then
 * it revokes every token two ways — on the listing alone, and the way the kit's routes call it, with the ids the kit
 * recorded — and asks git, not the listing, which tokens still work: a token is live when Cloudflare's git endpoint
 * accepts it as the Basic password. Both ways are asserted to leave no token working.
 *
 * ## Everything it creates, it reaps
 *
 * The Worker and the namespace are both `uniqueName`s, so they sit in the `pithy-int-` reservation and the run's
 * sweep (`reap.ts`, "Artifacts namespace" and "Worker script") reclaims whatever an aborted run leaves. A run costs a
 * few hundred Artifacts operations against the account's monthly allowance.
 */

const creds = loadIntegrationCreds();
const ready = fixtureReady("cloudflare-account");
const run = promisify(execFile);

/** The kit's binding module, which the Worker imports by absolute path so the bundle carries the real code. */
const BINDING_MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts.ts");
/** This package's root, where `wrangler` and the kit's dependencies resolve. */
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** How many tokens one mint request makes, and how many the suite will make before giving up on a page boundary. */
const MINT_BATCH = 25;
const MINT_CAP = 400;
/**
 * A fresh `workers.dev` address answers from the machines that have the script, and Cloudflare's own HTML page
 * from the ones that do not yet. One good `/ready` proves only the machine that answered it, so the suite waits for
 * the shared settle rule's agreeing reads, each the probe's own JSON, inside the shared settle budget.
 */
const READY = "ready";

/**
 * The Worker, as TypeScript. Every route needs the run's probe key, so the address answers nobody else. It holds one
 * repository, `probe`, and hands each mint's plaintext back to the suite: the suite is the git client.
 */
const ENTRY = `
import { revokeEveryToken } from ${JSON.stringify(BINDING_MODULE)};

const REPO = "probe";

export default {
  async fetch(request, env) {
    if (request.headers.get("x-probe-key") !== env.PROBE_KEY) return new Response("no", { status: 404 });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ready") return Response.json({ ready: true });
      if (url.pathname === "/repo" && request.method === "POST") {
        const created = await env.ARTIFACTS.create(REPO);
        const repo = await env.ARTIFACTS.get(REPO);
        // The kit revokes the token a create answers with before anybody can read it. So does this.
        await repo.revokeToken(created.token);
        return Response.json({ remote: created.remote });
      }
      const repo = await env.ARTIFACTS.get(REPO);
      if (url.pathname === "/mint" && request.method === "POST") {
        const count = Number(url.searchParams.get("count") ?? "1");
        const minted = [];
        for (let i = 0; i < count; i += 1) {
          const token = await repo.createToken("read", 3600);
          minted.push({ id: token.id, plaintext: token.plaintext });
        }
        return Response.json({ minted });
      }
      if (url.pathname === "/tokens") {
        const listed = await repo.listTokens();
        return Response.json({
          tokens: listed.tokens.map((t) => ({ id: t.id, state: t.state, createdAt: t.createdAt })),
          total: listed.total,
        });
      }
      if (url.pathname === "/revoke" && request.method === "POST") {
        const { id } = await request.json();
        return Response.json({ revoked: await repo.revokeToken(id) });
      }
      if (url.pathname === "/revoke-all" && request.method === "POST") {
        const { recorded } = await request.json();
        return Response.json({ revoked: await revokeEveryToken(repo, recorded) });
      }
      return new Response("unknown", { status: 404 });
    } catch (error) {
      return Response.json({ failure: String(error), code: error?.code ?? null }, { status: 500 });
    }
  },
};
`;

/** What the Worker answers, validated: a response read is a boundary like any other. */
const Minted = z
  .object({
    minted: z
      .array(
        z
          .object({
            id: z.string().describe("The token's id."),
            plaintext: z.string().describe("The token itself, which the suite presents to git."),
          })
          .describe("One minted token."),
      )
      .describe("Every token one request minted, in mint order."),
  })
  .describe("The Worker's answer to a mint.");

const Listed = z
  .object({
    tokens: z
      .array(
        z
          .object({
            id: z.string().describe("The token's id."),
            state: z.string().describe("Its state, as the binding reports it."),
            createdAt: z.string().describe("When it was minted, as the binding reports it."),
          })
          .describe("One listed token."),
      )
      .describe("One page of the listing, exactly as the binding answered it."),
    total: z.number().describe("The binding's `total`."),
  })
  .describe("One `listTokens()` answer.");

const Revoked = z
  .object({ revoked: z.number().describe("What `revokeEveryToken` answered.") })
  .describe("A revoke-all.");

const RevokedOne = z
  .object({ revoked: z.boolean().describe("What `revokeToken` answered.") })
  .describe("A revoke of one token.");

type Token = z.output<typeof Minted>["minted"][number];

describe.skipIf(!ready)("revokeEveryToken against a real Artifacts namespace — LIVE", () => {
  const clients = new CloudflareClients({ accountId: creds.accountId, apiToken: creds.apiToken });
  const worker = uniqueName("revoke-all");
  const namespace = uniqueName("artifacts");
  const probeKey = crypto.randomUUID();
  let origin = "";
  let remote = "";
  /** Every token minted, so the kit's way can be handed every id the kit would have recorded. */
  const everyMinted: Token[] = [];
  /** The page size the measurement found. */
  let pageSize = 0;

  async function call(pathname: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(`${origin}${pathname}`, {
      ...init,
      headers: { "x-probe-key": probeKey, "content-type": "application/json", ...init.headers },
    });
    return readWorkerAnswer(pathname, response);
  }

  async function mint(count: number): Promise<Token[]> {
    const { minted } = Minted.parse(await call(`/mint?count=${count}`, { method: "POST" }));
    everyMinted.push(...minted);
    return minted;
  }

  const list = async () => Listed.parse(await call("/tokens"));

  /** Whether Cloudflare's git endpoint still takes this token. Asked of git, never of the listing under test. */
  async function works(token: Token): Promise<boolean> {
    const response = await fetch(`${remote}/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${btoa(`x:${token.plaintext}`)}` },
    });
    await response.body?.cancel();
    if (response.status === 200) return true;
    if (response.status === 401 || response.status === 403) return false;
    throw new Error(`git answered ${response.status} for token ${token.id}`);
  }

  async function stillWorking(tokens: readonly Token[]): Promise<Token[]> {
    const live: Token[] = [];
    for (const token of tokens) if (await works(token)) live.push(token);
    return live;
  }

  beforeAll(async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pithy-revoke-all-"));
    try {
      await writeFile(path.join(dir, "index.ts"), ENTRY);
      await writeFile(
        path.join(dir, "wrangler.jsonc"),
        JSON.stringify({
          name: worker,
          main: "index.ts",
          compatibility_date: INTEGRATION_COMPATIBILITY_DATE,
          compatibility_flags: ["nodejs_compat"],
        }),
      );
      // Bundled by wrangler and uploaded through the manager, the path every other live Worker here takes.
      await run(
        "bun",
        [
          "x",
          "wrangler",
          "deploy",
          "--dry-run",
          "--outdir",
          path.join(dir, "out"),
          "--config",
          path.join(dir, "wrangler.jsonc"),
        ],
        {
          cwd: PACKAGE_ROOT,
        },
      );
      const body = await readFile(path.join(dir, "out", "index.js"), "utf8");
      const workers = clients.workers();
      await workers.createWorker(
        worker,
        INTEGRATION_COMPATIBILITY_DATE,
        {
          compatibility_flags: ["nodejs_compat"],
          bindings: [
            { type: "artifacts", name: "ARTIFACTS", namespace },
            { type: "secret_text", name: "PROBE_KEY", text: probeKey },
          ],
        },
        { name: "index.js", body },
      );
      await workers.setSubdomainSettings(worker, true, false);
      const subdomain = await workers.accountSubdomain();
      if (!subdomain)
        throw new Error("The account has no workers.dev subdomain. Open Workers & Pages once to make one.");
      origin = `https://${worker}.${subdomain}.workers.dev`;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    await waitForStable(
      `${origin} to answer as the probe`,
      () =>
        call("/ready").then(
          (body) => (z.object({ ready: z.literal(true) }).safeParse(body).success ? READY : JSON.stringify(body)),
          (error: unknown) => String(error),
        ),
      (answer) => answer === READY,
    );
    remote = z
      .object({ remote: z.string().describe("The clone URL.") })
      .parse(await call("/repo", { method: "POST" })).remote;
  }, 300_000);

  afterAll(async () => {
    await clients
      .workers()
      .deleteWorker(worker)
      .catch(() => undefined);
    // A repository delete is 202 Accepted, so the namespace can be held a moment; the sweep takes what is left.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await reapArtifactsNamespace(clients.artifacts(), namespace);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }, 120_000);

  test("records what listTokens() returns: which states, how many a page, in what order", async ({ annotate }) => {
    let listed = await list();
    while (listed.tokens.length >= listed.total && everyMinted.length < MINT_CAP) {
      await mint(MINT_BATCH);
      listed = await list();
    }
    expect(
      listed.tokens.length,
      `listTokens() answered all ${listed.total} tokens on one page; raise MINT_CAP to cross a page`,
    ).toBeLessThan(listed.total);
    pageSize = listed.tokens.length;

    // A token that works before anything is revoked, so "does not work" below is not a probe that always says no.
    const fresh = everyMinted.at(-1);
    if (!fresh) throw new Error("nothing was minted");
    expect(await works(fresh)).toBe(true);

    const mintOrder = new Map(everyMinted.map((token, index) => [token.id, index]));
    const positions = listed.tokens.map((token) => mintOrder.get(token.id) ?? -1);
    const ascending = positions.every((value, index) => index === 0 || value > (positions[index - 1] ?? -1));
    const descending = positions.every((value, index) => index === 0 || value < (positions[index - 1] ?? -1));
    const order = ascending ? "oldest first" : descending ? "newest first" : "neither oldest nor newest first";

    const shown = listed.tokens.slice(0, 3).map((token) => token.id);
    for (const id of shown) {
      expect(RevokedOne.parse(await call("/revoke", { method: "POST", body: JSON.stringify({ id }) })).revoked).toBe(
        true,
      );
    }
    const after = await list();
    const states = [...new Set(after.tokens.map((token) => token.state))].sort();
    const keepsRevoked = after.tokens.some((token) => shown.includes(token.id));

    const record = `listTokens(): ${pageSize} a page of ${listed.total}, ${order}; states listed after revoking three: ${states.join(", ")}; revoked tokens ${keepsRevoked ? "stay on the page" : "leave the page"}.`;
    console.info(record);
    await annotate(record, "notice");
    expect(["active", "expired", "revoked"]).toEqual(expect.arrayContaining(states));
  }, 600_000);

  test("on the listing alone, reaches past the first page and leaves no token working", async ({ annotate }) => {
    expect(pageSize, "the measurement above must cross a page first").toBeGreaterThan(0);
    // More live tokens than one page holds, so a sweep that stops after the first page leaves some working.
    while ((await list()).total - 3 <= pageSize) await mint(MINT_BATCH);
    const { revoked } = Revoked.parse(
      await call("/revoke-all", { method: "POST", body: JSON.stringify({ recorded: [] }) }),
    );
    const left = await stillWorking(everyMinted);
    const record = `revokeEveryToken on the listing alone revoked ${revoked} and left ${left.length} of ${everyMinted.length} working.`;
    console.info(record);
    await annotate(record, "notice");
    expect(left.map((token) => token.id)).toEqual([]);
  }, 600_000);

  test("the way the kit calls it, with every recorded id, leaves no token working", async () => {
    expect(pageSize, "the measurement above must cross a page first").toBeGreaterThan(0);
    // A fresh set past one page, so this case does not rest on what the listing-alone case left.
    while (everyMinted.length < 2 * pageSize + MINT_BATCH) await mint(MINT_BATCH);
    for (let i = 0; i < pageSize + 1; i += MINT_BATCH) await mint(MINT_BATCH);
    const recorded = everyMinted.map((token) => token.id);
    Revoked.parse(await call("/revoke-all", { method: "POST", body: JSON.stringify({ recorded }) }));

    expect((await stillWorking(everyMinted)).map((token) => token.id)).toEqual([]);
    expect((await list()).tokens.filter((token) => token.state === "active")).toEqual([]);
  }, 600_000);
});
