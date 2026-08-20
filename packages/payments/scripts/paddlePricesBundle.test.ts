// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Window } from "happy-dom";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildPaddlePricesBundle } from "./paddlePricesBundle";

/**
 * The browser build, exercised as a browser loads it.
 *
 * **Against the built file, never against the source.** A static site loads one artifact; a test that
 * imported `../src/client/paddlePrices.iife.ts` would prove the modules compose and prove nothing about the
 * thing that ships — not that it bundles, not that it runs as a classic script, not that it finds its own
 * tag. Each of those is a way the artifact can be broken while every unit test stays green.
 *
 * Paddle is never contacted. `@paddle/paddle-js` resolves `window.PaddleBillingV1` when the page already
 * has one, so a stub set before the script runs is the whole of the seam, and nothing here reaches
 * `cdn.paddle.com`.
 */

/** This file's own directory, so the recording is found however the suite was launched. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The price the recording quotes. */
const SOLO_PRICE = "pri_01kzvyz9e21z9vbhd7xqq3csyh";

/** A second plan, quoted from a line cloned off the recording. */
const TEAM_PRICE = "pri_01kzvyz9khsdy36z10wb8bgmq4";

/** Where the artifact under test was written. */
let bundle = "";

/** The temporary directory holding it. */
let out = "";

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "pithy-prices-"));
  bundle = await readFile(await buildPaddlePricesBundle(out), "utf8");
});

afterAll(async () => {
  await rm(out, { recursive: true, force: true });
});

/**
 * New York, recorded, with a second line for {@link TEAM_PRICE}.
 *
 * Read off `src/client/fixtures/` rather than imported: those modules belong to the browser program and
 * this test is about a file on disk. The second line is cloned from the first — the claim it feeds is
 * that each plan takes the line its own id names, and every figure in it is still Paddle's.
 */
async function recorded(): Promise<unknown> {
  const path = join(HERE, "..", "src", "client", "fixtures", "price-preview-us-new-york.json");
  const data = JSON.parse(await readFile(path, "utf8")) as {
    details: { lineItems: { price: { id: string }; product: { name: string } }[] };
  };
  const [solo] = data.details.lineItems;
  if (solo === undefined) throw new Error(`the recording at ${path} has no line item`);
  const team = structuredClone(solo);
  team.price.id = TEAM_PRICE;
  team.product.name = "Team";
  data.details.lineItems.push(team);
  return { data, meta: { requestId: "not-read-by-anything" } };
}

/** A Paddle.js on the page before the artifact runs, answering with `answer`. */
function stubPaddle(window: Window, answer: unknown): { queries: unknown[] } {
  const queries: unknown[] = [];
  const paddle = {
    Initialized: false,
    Environment: { set: () => undefined },
    Initialize: () => {
      paddle.Initialized = true;
    },
    PricePreview: (query: unknown) => {
      queries.push(query);
      return Promise.resolve(answer);
    },
  };
  (window as unknown as Record<string, unknown>).PaddleBillingV1 = paddle;
  return { queries };
}

/**
 * Run the artifact on a page in an existing window, with a fresh Paddle behind it.
 *
 * Separate from {@link load} so a test can run it twice in **one** window — which is the only way to
 * exercise a cache, since a `Window` gets its own `localStorage` and two of them share nothing. The
 * second run is a second page of the same site: same store, new script, a Paddle that would answer if
 * anything asked it.
 */
async function run(
  window: Window,
  attributes: Record<string, string>,
  answer: unknown,
): Promise<{ queries: unknown[] }> {
  const paddle = stubPaddle(window, answer);
  window.document.body.innerHTML = `
    <p data-price-plan="solo">Priced where you are billed</p><small data-price-note="solo"></small>
    <p data-price-plan="team">Priced where you are billed</p><small data-price-note="team"></small>`;
  const script = window.document.createElement("script");
  for (const [name, value] of Object.entries(attributes)) script.setAttribute(name, value);
  script.textContent = bundle;
  window.document.head.appendChild(script);
  await window.happyDOM.waitUntilComplete();
  return paddle;
}

/** A pricing page carrying the artifact, its configuration, and one slot per plan. */
async function load(attributes: Record<string, string>, answer: unknown): Promise<Window> {
  const window = new Window({ url: "https://pithy.sh/pricing/", settings: { enableJavaScriptEvaluation: true } });
  await run(window, attributes, answer);
  return window;
}

/** What each plan slot on the page now reads. */
function painted(window: Window): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const node of window.document.querySelectorAll("[data-price-plan]")) {
    slots[node.getAttribute("data-price-plan") ?? ""] = (node.textContent ?? "").trim();
  }
  return slots;
}

/** What each tax-sentence slot on the page now reads. */
function noted(window: Window): Record<string, string> {
  const slots: Record<string, string> = {};
  for (const node of window.document.querySelectorAll("[data-price-note]")) {
    slots[node.getAttribute("data-price-note") ?? ""] = (node.textContent ?? "").trim();
  }
  return slots;
}

/** A tag with a real token and a real id for each plan on the page. */
const CONFIGURED = {
  "data-paddle-env": "sandbox",
  "data-paddle-token": "test_pithyNotARealClientToken",
  "data-paddle-price-solo": SOLO_PRICE,
  "data-paddle-price-team": TEAM_PRICE,
};

describe("paddle-prices.iife.js", () => {
  test("quotes every plan named on its own tag and writes the totals into the page", async () => {
    // The recording is the `{ data, meta }` envelope `PricePreview()` actually resolves. A reader that
    // took `currencyCode` off the top of it would refuse this and paint nothing, which is exactly how
    // #416 stayed invisible for months — so this assertion is that gate as well as this one.
    const window = await load(CONFIGURED, await recorded());
    expect(painted(window)).toEqual({ solo: "$5.00", team: "$5.00" });
  });

  test("writes the tax sentence beside each figure, because the figure alone is not the price", async () => {
    // New York, recorded: $5.00 listed and $5.44 charged. A page showing only the headline is showing a
    // number nobody pays.
    const window = await load(CONFIGURED, await recorded());
    expect(noted(window)).toEqual({ solo: "Plus $0.44 tax.", team: "Plus $0.44 tax." });
  });

  test("leaves the page's own sentence standing when the token is still a placeholder", async () => {
    const window = await load(
      { ...CONFIGURED, "data-paddle-token": "REPLACE_WITH_LIVE_CLIENT_TOKEN" },
      await recorded(),
    );
    expect(painted(window)).toEqual({ solo: "Priced where you are billed", team: "Priced where you are billed" });
  });

  test("leaves the page's own sentence standing when a price id is still a placeholder", async () => {
    const window = await load(
      { ...CONFIGURED, "data-paddle-price-team": "REPLACE_WITH_LIVE_TEAM_PRICE_ID" },
      await recorded(),
    );
    expect(painted(window)).toEqual({ solo: "Priced where you are billed", team: "Priced where you are billed" });
  });

  test("caches across pages when the tag names a cache, so the second page costs no round trip", async () => {
    const cached = {
      ...CONFIGURED,
      "data-paddle-cache": "pricing",
      "data-paddle-cache-store": "local",
      "data-paddle-cache-ttl": "300",
    };
    const window = new Window({ url: "https://pithy.sh/pricing/", settings: { enableJavaScriptEvaluation: true } });
    await run(window, cached, await recorded());

    const second = await run(window, cached, await recorded());

    expect(second.queries).toEqual([]);
    expect(painted(window)).toEqual({ solo: "$5.00", team: "$5.00" });
  });

  test("asks again on the second page when the tag named no cache", async () => {
    // The other half of the pair. Without it the test above would pass on an artifact that never quoted
    // twice for any reason at all.
    const window = new Window({ url: "https://pithy.sh/pricing/", settings: { enableJavaScriptEvaluation: true } });
    await run(window, CONFIGURED, await recorded());

    const second = await run(window, CONFIGURED, await recorded());

    expect(second.queries).toHaveLength(1);
  });

  test("quotes the customer the tag names, so one artifact serves a signed-in page too", async () => {
    const window = new Window({ url: "https://pithy.sh/pricing/", settings: { enableJavaScriptEvaluation: true } });
    const paddle = await run(
      window,
      { ...CONFIGURED, "data-paddle-customer": "ctm_01kzvyz9pithyNotARealCustomer" },
      await recorded(),
    );

    expect(paddle.queries).toEqual([
      {
        items: [
          { priceId: SOLO_PRICE, quantity: 1 },
          { priceId: TEAM_PRICE, quantity: 1 },
        ],
        customerId: "ctm_01kzvyz9pithyNotARealCustomer",
      },
    ]);
  });

  test("names no account and no price of its own", () => {
    // The contract is that configuration arrives on the tag. An id compiled into the artifact would make
    // one build serve one account, which is the thing this replaces.
    expect(bundle).not.toMatch(/\bpri_[a-z0-9]/i);
    expect(bundle).not.toMatch(/\b(live|test)_[a-z0-9]{8}/i);
  });

  test("carries no import a browser would have to resolve", () => {
    expect(bundle).not.toMatch(/^\s*(import|export)\s/m);
  });
});
