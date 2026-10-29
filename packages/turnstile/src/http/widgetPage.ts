// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { TurnstileMode } from "../config/config";

/**
 * The widget page a native app loads in a WebView: Cloudflare's widget, rendered on the Worker's own origin,
 * posting what it solves to the app over `window.ReactNativeWebView.postMessage`.
 *
 * Every message is a JSON string, one of three shapes:
 *
 *   { "type": "turnstile", "token": "<response token>" }   solved; send it as `cf-turnstile-response`
 *   { "type": "turnstile-expired" }                        the token lapsed, or the challenge timed out
 *   { "type": "turnstile-error" }                          the widget, or Cloudflare's script, failed
 *
 * Pure: values in, a `Response` out. The route resolves the sitekey and the mode; this module renders them.
 */

/** Where the page is served. Under `/turnstile`, which already reaches the Worker ahead of a front end. */
export const TURNSTILE_WIDGET_PATH = "/turnstile/widget";

/** The one origin the page loads anything from: Cloudflare's challenge script, its frame and its calls. */
export const TURNSTILE_SCRIPT_ORIGIN = "https://challenges.cloudflare.com";

/** The global Cloudflare's script calls once it has loaded, named in its `onload` parameter. */
const ONLOAD = "pithyTurnstileLoaded";

const SCRIPT_SRC = `${TURNSTILE_SCRIPT_ORIGIN}/turnstile/v0/api.js?render=explicit&onload=${ONLOAD}`;

/** What one render of the page needs. Every string here is escaped before it reaches the HTML. */
export interface WidgetPageInput {
  /** The public sitekey for the Worker's environment. */
  sitekey: string;
  /** The action the widget solves for; the gate asserts it. */
  action: string;
  /** The widget mode `protect.login` names. */
  mode: TurnstileMode;
  /** The widget's color scheme. */
  theme: "auto" | "light" | "dark";
  /** The widget's language, or `auto` for the device's. */
  language: string;
  /** This response's CSP nonce, from {@link mintNonce}. */
  nonce: string;
}

/** A fresh CSP nonce: 128 random bits, base64. One per response, never reused. */
export function mintNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The bridge. It reads its inputs from the host element's attributes, so nothing is interpolated into
 * script. It posts to the React Native bridge alone: the page refuses to be framed, so there is no parent
 * to post to, and on the web the app renders Cloudflare's widget itself.
 */
const BRIDGE = `(function () {
  var host = document.getElementById("turnstile");
  function send(message) {
    var bridge = window.ReactNativeWebView;
    if (bridge && typeof bridge.postMessage === "function") bridge.postMessage(JSON.stringify(message));
  }
  window.addEventListener("error", function (event) {
    if (event.target && event.target.tagName === "SCRIPT") send({ type: "turnstile-error" });
  }, true);
  window.${ONLOAD} = function () {
    window.turnstile.render(host, {
      sitekey: host.dataset.sitekey,
      action: host.dataset.action,
      appearance: host.dataset.mode === "invisible" ? "execute" : "always",
      theme: host.dataset.theme,
      language: host.dataset.language,
      size: "flexible",
      callback: function (token) { send({ type: "turnstile", token: token }); },
      "expired-callback": function () { send({ type: "turnstile-expired" }); },
      "timeout-callback": function () { send({ type: "turnstile-expired" }); },
      "error-callback": function () { send({ type: "turnstile-error" }); }
    });
  };
})();`;

const STYLE = `html,body{margin:0;padding:0;background:transparent}
body{display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui,-apple-system,sans-serif}
#turnstile{width:100%;max-width:400px;padding:0 8px;box-sizing:border-box}`;

/** The page's HTML. */
function html(input: WidgetPageInput): string {
  const nonce = escapeHtml(input.nonce);
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    "<title>Humanity check</title>",
    `<style nonce="${nonce}">${STYLE}</style>`,
    "</head><body>",
    `<div id="turnstile" data-sitekey="${escapeHtml(input.sitekey)}" data-action="${escapeHtml(input.action)}"`,
    ` data-mode="${escapeHtml(input.mode)}" data-theme="${escapeHtml(input.theme)}"`,
    ` data-language="${escapeHtml(input.language)}"></div>`,
    "<noscript>This check needs JavaScript.</noscript>",
    `<script nonce="${nonce}">${BRIDGE}</script>`,
    `<script nonce="${nonce}" src="${escapeHtml(SCRIPT_SRC)}" async defer></script>`,
    "</body></html>",
  ].join("");
}

/**
 * The page's security policy. Script and style run by nonce; Cloudflare's origin may load its script, frame
 * and calls; nothing may frame the page, submit a form from it or rebase its URLs.
 */
function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' ${TURNSTILE_SCRIPT_ORIGIN}`,
    `style-src 'nonce-${nonce}'`,
    `frame-src ${TURNSTILE_SCRIPT_ORIGIN}`,
    `connect-src ${TURNSTILE_SCRIPT_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/**
 * The widget page. `no-store`, because the nonce in its policy is minted per response and a cached copy
 * would replay it.
 */
export function widgetPage(input: WidgetPageInput): Response {
  return new Response(html(input), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": contentSecurityPolicy(input.nonce),
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin",
    },
  });
}
