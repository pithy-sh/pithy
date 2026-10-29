import { TURNSTILE_SCRIPT_ORIGIN, TURNSTILE_WIDGET_PATH } from "@pithy-sh/turnstile/src/http/widgetPage";
import { type ReactNode, useRef } from "react";
import { View } from "react-native";
import { WebView } from "react-native-webview";
import { origin, turnstileConfig } from "./pithy-config";
import { onDevice, queryString } from "./platform";
import { useTheme } from "./theme";
import { useTurnstileWeb } from "./useTurnstileWeb";

/**
 * The humanity check in front of sign-in, when the Worker composes Turnstile.
 *
 * On a phone, Cloudflare's widget runs in a WebView on a page the Worker serves from its own origin, and the page
 * posts the token back. The WebView loads nothing but that page and Cloudflare's challenge, and a message from any
 * other page is dropped, so nothing else can hand the app a token. On the web the widget renders into the page.
 *
 * Either way the token goes where the Worker reads it: {@link turnstileRequest} puts it in the body field or the
 * header the projection names.
 */

/**
 * Where the token goes on a gated request: `token.header` when one is configured, `token.field` in the body
 * otherwise. Returns both halves already decided.
 */
export function turnstileRequest(
  body: Record<string, unknown>,
  value: string | null,
): { body: Record<string, unknown>; headers: Record<string, string> } {
  if (!turnstileConfig.enabled || !value) return { body, headers: {} };
  if (turnstileConfig.token.header) return { body, headers: { [turnstileConfig.token.header]: value } };
  return { body: { ...body, [turnstileConfig.token.field]: value }, headers: {} };
}

/** True when a gated form still needs a token before it can submit. */
export function turnstilePending(value: string | null): boolean {
  return turnstileConfig.enabled && !value;
}

/** The widget page's address on the Worker, drawn in the app's color scheme. */
export function widgetUrl(scheme: "light" | "dark"): string {
  return `${origin}${TURNSTILE_WIDGET_PATH}${queryString({ theme: scheme })}`;
}

/** Whether `url` is the Worker's widget page, query aside. */
function isWidgetPage(url: string): boolean {
  const page = `${origin}${TURNSTILE_WIDGET_PATH}`;
  return url === page || url.startsWith(`${page}?`) || url.startsWith(`${page}#`);
}

/**
 * Whether the WebView may load `url`: the widget page itself, and Cloudflare's challenge in its frames. Everything
 * else is refused, so a link inside a challenge can never take the view somewhere else.
 */
export function allowWidgetNavigation(url: string, isTopFrame = true): boolean {
  if (isWidgetPage(url)) return true;
  if (isTopFrame) return false;
  return url.startsWith(`${TURNSTILE_SCRIPT_ORIGIN}/`) || url === "about:blank" || url === "about:srcdoc";
}

/** What the widget page said. */
export type TurnstileMessage = { kind: "token"; token: string } | { kind: "expired" } | { kind: "error" };

/**
 * The message a WebView event carries, or `null` when it is not one the widget page sent: posted from any other
 * page, not JSON, or not one of the page's three shapes.
 */
export function turnstileMessage(event: { url: string; data: string }): TurnstileMessage | null {
  if (!isWidgetPage(event.url)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { type, token } = parsed as { type?: unknown; token?: unknown };
  if (type === "turnstile" && typeof token === "string" && token !== "") return { kind: "token", token };
  if (type === "turnstile-expired") return { kind: "expired" };
  if (type === "turnstile-error") return { kind: "error" };
  return null;
}

/** The widget in a WebView on the Worker's origin. */
function DeviceTurnstile(props: { onToken: (value: string | null) => void }): ReactNode {
  const theme = useTheme();
  const invisible = turnstileConfig.mode === "invisible";
  return (
    <WebView
      testID="turnstile"
      source={{ uri: widgetUrl(theme.scheme) }}
      originWhitelist={[origin, TURNSTILE_SCRIPT_ORIGIN]}
      onShouldStartLoadWithRequest={(request) => allowWidgetNavigation(request.url, request.isTopFrame ?? true)}
      onMessage={(event) => {
        const message = turnstileMessage(event.nativeEvent);
        if (message) props.onToken(message.kind === "token" ? message.token : null);
      }}
      onError={() => props.onToken(null)}
      onHttpError={() => props.onToken(null)}
      javaScriptEnabled
      scrollEnabled={false}
      style={{ height: invisible ? 1 : 72, opacity: invisible ? 0 : 1, backgroundColor: "transparent" }}
    />
  );
}

/** The widget rendered into the page, on the web. */
function WebTurnstile(props: { onToken: (value: string | null) => void }): ReactNode {
  const host = useRef<View>(null);
  useTurnstileWeb(host, turnstileConfig.enabled, props.onToken);
  return <View ref={host} testID="turnstile" style={{ width: "100%" }} />;
}

/** The widget. Renders nothing when the capability is not composed. Keep `onToken` stable across renders. */
export function Turnstile(props: { onToken: (value: string | null) => void }): ReactNode {
  if (!turnstileConfig.enabled) return null;
  return onDevice() ? <DeviceTurnstile onToken={props.onToken} /> : <WebTurnstile onToken={props.onToken} />;
}
