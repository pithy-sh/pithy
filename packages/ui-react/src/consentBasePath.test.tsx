// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentFetch } from "@pithy-sh/consent/src/client/api";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import Consent, { ConsentScreen } from "../templates/src/routes/pithy/consent";

/**
 * The consent screen against a Worker composing `consent({ basePath: "/privacy" })`: `virtual:pithy/consent` serves
 * that projection, the screen narrows it itself, and calls under it.
 */

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("virtual:pithy/consent", () => ({ default: { enabled: true, basePath: "/privacy" } }));

const ME = { subject: { kind: "visitor", id: "v-1" }, purposes: [], records: [] };

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  vi.unstubAllGlobals();
});

async function mount(node: ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("the consent screen at a custom base path", () => {
  test("the scaffolded route calls the base path the Worker composed", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return json(ME);
    });
    await mount(<Consent />);
    await vi.waitFor(() => expect(calls).toContain("/privacy/me"));
    expect(calls.some((url) => url.startsWith("/consent/"))).toBe(false);
  });

  test("a screen handed only a fetch still calls the configured base path", async () => {
    const calls: string[] = [];
    const fetcher: ConsentFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ME };
    };
    await mount(<ConsentScreen client={{ fetch: fetcher }} />);
    await vi.waitFor(() => expect(calls).toContain("/privacy/me"));
  });
});
