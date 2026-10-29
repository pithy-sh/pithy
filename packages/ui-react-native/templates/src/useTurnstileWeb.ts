import { useRead } from "@pithy-sh/ui-core/src/read";
import { type RefObject, useEffect } from "react";
import type { View } from "react-native";
import { turnstileConfig } from "./pithy-config";

/**
 * Cloudflare's Turnstile widget in the browser, for the web build. React Native Web renders a `View` as a DOM
 * element, so the widget renders into it the way it does on any page. Only the web build calls this; on a phone the
 * widget runs in a WebView on the Worker's own origin instead.
 *
 * This program has no DOM types, so the few calls it makes are declared here.
 */

const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    element: unknown,
    options: {
      sitekey: string;
      action: string;
      appearance: "always" | "execute";
      theme: "light" | "dark" | "auto";
      size: "normal" | "flexible" | "compact";
      callback: (value: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ): string;
  remove?(widget: string): void;
}

interface ScriptElement {
  src: string;
  async: boolean;
  onload: (() => void) | null;
  onerror: (() => void) | null;
}

interface Browser {
  turnstile?: TurnstileApi;
  document?: { createElement(tag: "script"): ScriptElement; head: { appendChild(node: ScriptElement): unknown } };
}

const browser = globalThis as unknown as Browser;

let script: Promise<void> | undefined;

/** Turnstile's script, appended once per page. A load that failed is forgotten, so the next widget asks again. */
function loadScript(): Promise<void> {
  if (browser.turnstile) return Promise.resolve();
  script ??= new Promise<void>((resolve, reject) => {
    const document = browser.document;
    if (!document) {
      reject(new Error("Turnstile needs a browser."));
      return;
    }
    const element = document.createElement("script");
    element.src = SCRIPT_SRC;
    element.async = true;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error("Turnstile failed to load."));
    document.head.appendChild(element);
  }).catch((failure: unknown) => {
    script = undefined;
    throw failure;
  });
  return script;
}

/**
 * Render the widget into `host` once its script has loaded, handing each token, and each expiry or failure as
 * `null`, to `onToken`, and take it off the page on unmount. A script that will not load answers `null`, so a form
 * waiting on a token says so.
 */
export function useTurnstileWeb(
  host: RefObject<View | null>,
  enabled: boolean,
  onToken: (value: string | null) => void,
): void {
  const loaded = useRead("turnstile-script", loadScript, { skip: !enabled });
  const state = loaded.failure ? "failed" : loaded.loading ? "loading" : "loaded";
  useEffect(() => {
    if (!enabled) return;
    if (state === "failed") {
      onToken(null);
      return;
    }
    const turnstile = browser.turnstile;
    if (state === "loading" || !host.current || !turnstile) return;
    const widget = turnstile.render(host.current, {
      sitekey: turnstileConfig.sitekey,
      // The action is the projection's, never retyped: the Worker asserts this exact string against the token.
      action: turnstileConfig.action,
      appearance: turnstileConfig.mode === "invisible" ? "execute" : "always",
      theme: "auto",
      size: "flexible",
      callback: (value) => onToken(value),
      "expired-callback": () => onToken(null),
      "error-callback": () => onToken(null),
    });
    return () => turnstile.remove?.(widget);
  }, [host, enabled, state, onToken]);
}
