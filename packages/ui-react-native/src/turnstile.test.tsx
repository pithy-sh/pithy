// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, cleanup, render, screen } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  allowWidgetNavigation,
  Turnstile,
  turnstileMessage,
  turnstilePending,
  turnstileRequest,
  widgetUrl,
} from "../templates/src/turnstile";
import { webViews } from "../testing/react-native-webview";

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
  origin: "https://api.example.com",
  get turnstileConfig() {
    return config.turnstile;
  },
}));

const PAGE = "https://api.example.com/turnstile/widget";

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  config.turnstile = {
    ...config.turnstile,
    enabled: true,
    mode: "visible",
    token: { field: "cf-turnstile-response", header: null },
  };
  vi.unstubAllGlobals();
});

describe("on a phone, the widget page in a WebView", () => {
  test("loads the Worker's own widget page, in the app's scheme", () => {
    Platform.OS = "ios";
    render(<Turnstile onToken={() => undefined} />);
    expect(webViews.last().source?.uri).toBe(widgetUrl("light"));
    expect(widgetUrl("dark")).toBe(`${PAGE}?theme=dark`);
    expect(webViews.last().originWhitelist).toEqual(["https://api.example.com", "https://challenges.cloudflare.com"]);
  });

  test("a token the page posts reaches the form, and an expiry or failure clears it", () => {
    Platform.OS = "android";
    const onToken = vi.fn();
    render(<Turnstile onToken={onToken} />);
    const post = (data: unknown) =>
      webViews.last().onMessage?.({ nativeEvent: { url: `${PAGE}?theme=light`, data: JSON.stringify(data) } });
    post({ type: "turnstile", token: "tok" });
    post({ type: "turnstile-expired" });
    post({ type: "turnstile-error" });
    expect(onToken.mock.calls).toEqual([["tok"], [null], [null]]);
  });

  test("a message from any other page is dropped", () => {
    Platform.OS = "ios";
    const onToken = vi.fn();
    render(<Turnstile onToken={onToken} />);
    for (const url of [
      "https://evil.test/turnstile/widget",
      "https://api.example.com/other",
      "https://api.example.com.evil.test/turnstile/widget",
    ]) {
      webViews
        .last()
        .onMessage?.({ nativeEvent: { url, data: JSON.stringify({ type: "turnstile", token: "forged" }) } });
    }
    expect(onToken).not.toHaveBeenCalled();
  });

  test("a page that will not load reads as no token", () => {
    Platform.OS = "ios";
    const onToken = vi.fn();
    render(<Turnstile onToken={onToken} />);
    webViews.last().onHttpError?.({ nativeEvent: { statusCode: 404 } });
    expect(onToken).toHaveBeenCalledWith(null);
  });

  test("the view goes nowhere but the widget page and Cloudflare's challenge frames", () => {
    expect(allowWidgetNavigation(`${PAGE}?theme=light`)).toBe(true);
    expect(allowWidgetNavigation("https://challenges.cloudflare.com/cdn-cgi/challenge", false)).toBe(true);
    expect(allowWidgetNavigation("about:blank", false)).toBe(true);
    expect(allowWidgetNavigation("https://challenges.cloudflare.com/cdn-cgi/challenge", true)).toBe(false);
    expect(allowWidgetNavigation("https://evil.test/", false)).toBe(false);
    expect(allowWidgetNavigation("https://api.example.com/auth/sign-out")).toBe(false);
    expect(allowWidgetNavigation("https://api.example.com/turnstile/widget-other")).toBe(false);
    expect(allowWidgetNavigation("https://api.example.com.evil.test/turnstile/widget")).toBe(false);
    expect(allowWidgetNavigation("https://challenges.cloudflare.com.evil.test/", false)).toBe(false);
  });

  test("the mounted view asks that gate before every load", () => {
    Platform.OS = "android";
    render(<Turnstile onToken={() => undefined} />);
    const gate = webViews.last().onShouldStartLoadWithRequest;
    expect(gate?.({ url: `${PAGE}?theme=light`, isTopFrame: true })).toBe(true);
    expect(gate?.({ url: "https://evil.test/", isTopFrame: true })).toBe(false);
    expect(gate?.({ url: "https://challenges.cloudflare.com/cdn-cgi/challenge" })).toBe(false);
    expect(gate?.({ url: "https://challenges.cloudflare.com/cdn-cgi/challenge", isTopFrame: false })).toBe(true);
  });

  test("a load that fails reads as no token", () => {
    Platform.OS = "ios";
    const onToken = vi.fn();
    render(<Turnstile onToken={onToken} />);
    webViews.last().onError?.({ nativeEvent: { description: "offline" } });
    expect(onToken).toHaveBeenCalledWith(null);
  });

  test("only the page's three shapes are messages", () => {
    const at = (data: string) => turnstileMessage({ url: PAGE, data });
    expect(at("not json")).toBeNull();
    expect(at(JSON.stringify({ type: "turnstile" }))).toBeNull();
    expect(at(JSON.stringify({ type: "turnstile", token: "" }))).toBeNull();
    expect(at(JSON.stringify({ type: "other" }))).toBeNull();
    expect(at(JSON.stringify(null))).toBeNull();
  });
});

describe("on the web, the widget in the page", () => {
  test("renders into the page with the projection's sitekey and action, and is removed on unmount", async () => {
    Platform.OS = "web";
    const remove = vi.fn();
    const render$ = vi.fn((_element: unknown, options: { callback: (value: string) => void }) => {
      options.callback("web-token");
      return "widget-1";
    });
    vi.stubGlobal("turnstile", { render: render$, remove });
    const onToken = vi.fn();
    let unmount: () => void = () => undefined;
    await act(async () => {
      unmount = render(<Turnstile onToken={onToken} />).unmount;
    });
    expect(render$).toHaveBeenCalledWith(
      screen.getByTestId("turnstile"),
      expect.objectContaining({ sitekey: "1x00000000000000000000AA", action: "login", appearance: "always" }),
    );
    expect(onToken).toHaveBeenCalledWith("web-token");
    expect(webViews.mounted).toEqual([]);
    unmount();
    expect(remove).toHaveBeenCalledWith("widget-1");
  });
});

describe("with Turnstile not composed", () => {
  test("renders nothing and gates nothing", () => {
    config.turnstile = { enabled: false };
    Platform.OS = "ios";
    const { container } = render(<Turnstile onToken={() => undefined} />);
    expect(container.innerHTML).toBe("");
    expect(turnstilePending(null)).toBe(false);
    expect(turnstileRequest({ email: "a" }, "tok")).toEqual({ body: { email: "a" }, headers: {} });
  });
});

describe("where the token goes", () => {
  test("into the body field the projection names", () => {
    expect(turnstileRequest({ email: "a" }, "tok")).toEqual({
      body: { email: "a", "cf-turnstile-response": "tok" },
      headers: {},
    });
    expect(turnstilePending(null)).toBe(true);
    expect(turnstilePending("tok")).toBe(false);
  });

  test("into the header instead, when one is configured", () => {
    config.turnstile = { ...config.turnstile, token: { field: "cf-turnstile-response", header: "x-turnstile" } };
    expect(turnstileRequest({ email: "a" }, "tok")).toEqual({
      body: { email: "a" },
      headers: { "x-turnstile": "tok" },
    });
  });
});
