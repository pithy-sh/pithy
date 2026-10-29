// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { mintNonce, TURNSTILE_SCRIPT_ORIGIN, type WidgetPageInput, widgetPage } from "./widgetPage";

const INPUT: WidgetPageInput = {
  sitekey: "1x00000000000000000000AA",
  action: "login",
  mode: "visible",
  theme: "auto",
  language: "auto",
  nonce: "bm9uY2Utb25l",
};

/** The page's directives as a map, so a test asserts one directive rather than a substring of the header. */
function directives(response: Response): Map<string, string> {
  const header = response.headers.get("content-security-policy") ?? "";
  return new Map(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name ?? "", values.join(" ")] as const;
      }),
  );
}

describe("widgetPage", () => {
  test("answers HTML that no cache keeps, since the nonce is minted per response", async () => {
    const response = widgetPage(INPUT);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  test("refuses to be framed by anyone, in both the CSP and the legacy header", () => {
    const response = widgetPage(INPUT);
    expect(directives(response).get("frame-ancestors")).toBe("'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  test("allows scripts by nonce and from Cloudflare's challenge origin, and nothing else", () => {
    const csp = directives(widgetPage(INPUT));
    expect(csp.get("default-src")).toBe("'none'");
    expect(csp.get("script-src")).toBe(`'nonce-${INPUT.nonce}' ${TURNSTILE_SCRIPT_ORIGIN}`);
    expect(csp.get("style-src")).toBe(`'nonce-${INPUT.nonce}'`);
    expect(csp.get("frame-src")).toBe(TURNSTILE_SCRIPT_ORIGIN);
    expect(csp.get("connect-src")).toBe(TURNSTILE_SCRIPT_ORIGIN);
    expect(csp.get("base-uri")).toBe("'none'");
    expect(csp.get("form-action")).toBe("'none'");
    expect(csp.get("script-src")).not.toContain("unsafe");
  });

  test("every script and style element carries the response's nonce", async () => {
    const html = await widgetPage(INPUT).text();
    const tags = [...html.matchAll(/<(script|style)\b[^>]*>/g)].map((match) => match[0]);
    expect(tags.length).toBeGreaterThanOrEqual(3);
    for (const tag of tags) expect(tag).toContain(`nonce="${INPUT.nonce}"`);
  });

  test("carries no inline event handler and no javascript: URL", async () => {
    const html = await widgetPage(INPUT).text();
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });

  test("loads Cloudflare's script for explicit rendering, calling back into the nonced script", async () => {
    const html = await widgetPage(INPUT).text();
    expect(html).toContain(
      `src="${TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/api.js?render=explicit&amp;onload=pithyTurnstileLoaded"`,
    );
    expect(html).toContain("window.pithyTurnstileLoaded = function");
  });

  test("renders the sitekey, action, mode, theme and language as attributes on the widget's host", async () => {
    const html = await widgetPage({ ...INPUT, mode: "invisible", theme: "dark", language: "pt-br" }).text();
    expect(html).toContain(`data-sitekey="${INPUT.sitekey}"`);
    expect(html).toContain('data-action="login"');
    expect(html).toContain('data-mode="invisible"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-language="pt-br"');
  });

  test("escapes every value it renders, so a hostile sitekey cannot leave its attribute", async () => {
    const hostile = `"><script>alert(1)</script><x a='`;
    const html = await widgetPage({ ...INPUT, sitekey: hostile, action: hostile }).text();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;x a=&#39;");
  });

  test("posts each outcome to the React Native bridge as JSON, in the three shapes a screen reads", async () => {
    const html = await widgetPage(INPUT).text();
    expect(html).toContain("window.ReactNativeWebView");
    expect(html).toContain("postMessage(JSON.stringify(message))");
    expect(html).toContain('send({ type: "turnstile", token: token })');
    expect(html).toContain('send({ type: "turnstile-expired" })');
    expect(html).toContain('send({ type: "turnstile-error" })');
  });

  test("never posts to a parent frame, since nothing may frame it", async () => {
    const html = await widgetPage(INPUT).text();
    expect(html).not.toContain("window.parent");
    expect(html).not.toContain("window.top");
  });
});

/**
 * Runs the page's inline script against a stub host, a stub `turnstile` and a stub React Native bridge, then
 * fires Cloudflare's onload. Returns what the widget was rendered with, its callbacks, and every message posted.
 */
async function runBridge(input: WidgetPageInput, options: { bridge?: boolean } = {}) {
  const html = await widgetPage(input).text();
  const source = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
  const attributes = Object.fromEntries(
    [...html.matchAll(/data-([a-z]+)="([^"]*)"/g)].map((match) => [match[1] ?? "", match[2] ?? ""]),
  );
  const posted: unknown[] = [];
  const rendered: { host?: unknown; params?: Record<string, unknown> } = {};
  const listeners: Array<(event: { target: { tagName: string } }) => void> = [];
  const host = { dataset: attributes };
  const win: Record<string, unknown> = {
    addEventListener: (_type: string, listener: (event: { target: { tagName: string } }) => void) =>
      listeners.push(listener),
    turnstile: {
      render: (target: unknown, params: Record<string, unknown>) => {
        rendered.host = target;
        rendered.params = params;
      },
    },
  };
  if (options.bridge !== false)
    win.ReactNativeWebView = { postMessage: (data: string) => posted.push(JSON.parse(data)) };
  const document = { getElementById: (id: string) => (id === "turnstile" ? host : null) };
  new Function("window", "document", source)(win, document);
  return { win, host, rendered, posted, listeners };
}

describe("the bridge script", () => {
  test("renders the widget on the host with the attributes the page carries", async () => {
    const { win, host, rendered } = await runBridge({ ...INPUT, theme: "dark", language: "pt-br" });
    (win.pithyTurnstileLoaded as () => void)();
    expect(rendered.host).toBe(host);
    expect(rendered.params).toMatchObject({
      sitekey: INPUT.sitekey,
      action: "login",
      appearance: "always",
      theme: "dark",
      language: "pt-br",
    });
  });

  test("an invisible widget only appears while it executes", async () => {
    const { win, rendered } = await runBridge({ ...INPUT, mode: "invisible" });
    (win.pithyTurnstileLoaded as () => void)();
    expect(rendered.params?.appearance).toBe("execute");
  });

  test("posts each outcome to the React Native bridge as a JSON message", async () => {
    const { win, rendered, posted } = await runBridge(INPUT);
    (win.pithyTurnstileLoaded as () => void)();
    const params = rendered.params as Record<string, (token?: string) => void>;
    params.callback?.("tok-123");
    params["expired-callback"]?.();
    params["timeout-callback"]?.();
    params["error-callback"]?.();
    expect(posted).toEqual([
      { type: "turnstile", token: "tok-123" },
      { type: "turnstile-expired" },
      { type: "turnstile-expired" },
      { type: "turnstile-error" },
    ]);
  });

  test("reports a script that failed to load as an error, and ignores other errors", async () => {
    const { listeners, posted } = await runBridge(INPUT);
    for (const listener of listeners) listener({ target: { tagName: "IMG" } });
    expect(posted).toEqual([]);
    for (const listener of listeners) listener({ target: { tagName: "SCRIPT" } });
    expect(posted).toEqual([{ type: "turnstile-error" }]);
  });

  test("posts nothing, and throws nothing, outside a React Native WebView", async () => {
    const { win, rendered } = await runBridge(INPUT, { bridge: false });
    (win.pithyTurnstileLoaded as () => void)();
    const params = rendered.params as Record<string, (token?: string) => void>;
    expect(() => params.callback?.("tok-123")).not.toThrow();
  });
});

describe("mintNonce", () => {
  test("is 128 bits of base64, different every time", () => {
    const first = mintNonce();
    expect(first).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(mintNonce()).not.toBe(first);
  });
});
