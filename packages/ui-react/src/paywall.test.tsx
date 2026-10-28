// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { routeTable } from "../templates/src/router";
import Paywall from "../templates/src/routes/pithy/paywall";

/**
 * Coming back from hosted Checkout, the paywall posts the session id once per return — StrictMode, the mode the
 * scaffold renders in, included — and posts nothing on an ordinary visit.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(async () => {
  await routeTable();
}, 120_000);

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

/** Render the paywall at `search` and count the purchase posts it makes. */
async function visit(search: string): Promise<string[]> {
  const posted: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/purchases")) posted.push(String(init?.body));
      return new Response("{}", { status: 500, headers: { "content-type": "application/json" } });
    }),
  );
  window.history.replaceState(null, "", `/paywall${search}`);
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(
      <StrictMode>
        <Suspense fallback={null}>
          <Paywall />
        </Suspense>
      </StrictMode>,
    );
  });
  for (let tick = 0; tick < 20; tick++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
    });
  }
  await act(async () => root.unmount());
  return posted;
}

describe("the paywall's return from checkout", () => {
  test("posts the returned session exactly once under StrictMode", async () => {
    const posted = await visit("?session=cs_test_123");
    expect(posted).toHaveLength(1);
    expect(JSON.parse(posted[0] ?? "{}")).toEqual({ rail: "stripe", receipt: "cs_test_123" });
  }, 30_000);

  test("an ordinary visit posts nothing", async () => {
    expect(await visit("")).toEqual([]);
  }, 30_000);
});
