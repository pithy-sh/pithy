// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, render } from "@testing-library/react";
import { type ReactNode, useRef } from "react";
import { Platform, View } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const config = vi.hoisted(() => ({
  turnstile: {
    enabled: true,
    sitekey: "1x00000000000000000000AA",
    action: "login",
    mode: "visible",
    token: { field: "cf-turnstile-response", header: null as string | null },
  } as Record<string, unknown>,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
  get turnstileConfig() {
    return config.turnstile;
  },
}));

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface RenderOptions {
  sitekey: string;
  action: string;
  appearance: string;
  callback: (value: string) => void;
  "expired-callback": () => void;
  "error-callback": () => void;
}

/** The script elements the hook appended to the page, held rather than loaded. */
let appended: HTMLScriptElement[] = [];

const os = Platform.OS;
beforeEach(() => {
  Platform.OS = "web";
  appended = [];
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    appended.push(node as unknown as HTMLScriptElement);
    return node;
  });
});

afterEach(() => {
  cleanup();
  Platform.OS = os;
  config.turnstile = { ...config.turnstile, mode: "visible" };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Mount the hook alone, into a host view, with a fresh copy of the module so no earlier load is remembered. */
async function mount(onToken: (value: string | null) => void): Promise<() => void> {
  const { useTurnstileWeb } = await import("../templates/src/useTurnstileWeb");
  function Widget(): ReactNode {
    const host = useRef<View | null>(null);
    useTurnstileWeb(host, true, onToken);
    return <View ref={host} testID="host" />;
  }
  let unmount: () => void = () => undefined;
  await act(async () => {
    unmount = render(<Widget />).unmount;
  });
  return unmount;
}

/** A Turnstile API that records each render, as the script defines it once it has loaded. */
function turnstileApi(): { render: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return { render: vi.fn((_host: unknown, _options: RenderOptions) => "widget-1"), remove: vi.fn() };
}

const optionsOf = (api: ReturnType<typeof turnstileApi>): RenderOptions =>
  api.render.mock.calls[0]?.[1] as RenderOptions;

describe("loading Turnstile's script", () => {
  test("appends the explicit-render script, and renders the widget once it has loaded", async () => {
    const onToken = vi.fn();
    await mount(onToken);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.src).toBe(SCRIPT_SRC);
    expect(appended[0]?.async).toBe(true);

    const api = turnstileApi();
    vi.stubGlobal("turnstile", api);
    await act(async () => {
      appended[0]?.onload?.(new Event("load"));
    });
    expect(api.render).toHaveBeenCalledTimes(1);
    expect(optionsOf(api)).toMatchObject({ sitekey: "1x00000000000000000000AA", action: "login" });
    expect(onToken).not.toHaveBeenCalled();
  });

  test("a script that fails to load answers no token, so the form says so", async () => {
    const onToken = vi.fn();
    await mount(onToken);
    await act(async () => {
      appended[0]?.onerror?.(new Event("error"));
    });
    expect(onToken).toHaveBeenCalledWith(null);
  });

  test("a script that failed to load is asked for again by the next widget", async () => {
    const unmount = await mount(vi.fn());
    await act(async () => {
      appended[0]?.onerror?.(new Event("error"));
    });
    unmount();
    const { useTurnstileWeb } = await import("../templates/src/useTurnstileWeb");
    function Again(): ReactNode {
      const host = useRef<View | null>(null);
      useTurnstileWeb(host, true, () => undefined);
      return <View ref={host} />;
    }
    await act(async () => {
      render(<Again />);
    });
    expect(appended).toHaveLength(2);
  });
});

describe("the widget", () => {
  test("in invisible mode, runs without showing itself", async () => {
    config.turnstile = { ...config.turnstile, mode: "invisible" };
    const api = turnstileApi();
    vi.stubGlobal("turnstile", api);
    await mount(vi.fn());
    expect(optionsOf(api).appearance).toBe("execute");
  });

  test("in visible mode, shows itself", async () => {
    const api = turnstileApi();
    vi.stubGlobal("turnstile", api);
    await mount(vi.fn());
    expect(optionsOf(api).appearance).toBe("always");
  });

  test("hands each token over, and clears it when it expires or the challenge fails", async () => {
    const api = turnstileApi();
    vi.stubGlobal("turnstile", api);
    const onToken = vi.fn();
    const unmount = await mount(onToken);
    const options = optionsOf(api);
    options.callback("first");
    options["expired-callback"]();
    options.callback("second");
    options["error-callback"]();
    expect(onToken.mock.calls).toEqual([["first"], [null], ["second"], [null]]);
    unmount();
    expect(api.remove).toHaveBeenCalledWith("widget-1");
  });
});
