import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { Platform } from "react-native";

/**
 * The few things a screen needs from the platform that React Native does not answer the same way everywhere.
 *
 * **Query strings and links are read by hand here, not with `URL` or `URLSearchParams`.** React Native ships both
 * names, but its `URL` does not parse and its `URLSearchParams` cannot read a value back, so code that works in a
 * browser and in a test throws on a phone. Everything in this file is plain string work that answers the same on
 * all three platforms.
 */

/** The platform a device registers as with the Worker. Anything React Native names other than a phone is the web. */
export function devicePlatform(): "ios" | "android" | "web" {
  if (Platform.OS === "ios" || Platform.OS === "android") return Platform.OS;
  return "web";
}

/** True on a phone, where there is no page origin and no cookie: the session is a bearer credential. */
export function onDevice(): boolean {
  return devicePlatform() !== "web";
}

/** One percent-encoded query component, decoded; a malformed escape keeps its raw text rather than throwing. */
function decodeComponent(value: string): string {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * A query string as name to value: `"?email=ada%40example.com"` gives `{ email: "ada@example.com" }`. The leading
 * `?` is optional. The first value of a repeated name wins, as `URLSearchParams.get` answers.
 */
export function parseQuery(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const pair of query.split("&")) {
    if (pair === "") continue;
    const split = pair.indexOf("=");
    const name = decodeComponent(split === -1 ? pair : pair.slice(0, split));
    const value = split === -1 ? "" : decodeComponent(pair.slice(split + 1));
    if (!(name in params)) params[name] = value;
  }
  return params;
}

/** One parameter of a query string, decoded, or `null` when the name is absent. */
export function searchParam(search: string, name: string): string | null {
  return parseQuery(search)[name] ?? null;
}

/** A query string from name to value, with its `?`, or the empty string when there is nothing to write. */
export function queryString(params: Readonly<Record<string, string>>): string {
  const pairs = Object.entries(params).map(
    ([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`,
  );
  return pairs.length === 0 ? "" : `?${pairs.join("&")}`;
}

/** A link split into its parts. `search` keeps its `?`, and is empty when there is none; the fragment is dropped. */
export interface ParsedLink {
  /** The scheme, lower-cased: `https`, or the app's own. */
  readonly scheme: string;
  /** What follows `//` up to the path: a host, or the first word of a custom-scheme link. */
  readonly host: string;
  /** The path, starting with `/`, or empty. */
  readonly path: string;
  /** The query, starting with `?`, or empty. */
  readonly search: string;
}

/**
 * Split `myapp://callback?code=…` or `https://app.example.com/return?session=…` into its parts, or answer `null`
 * for anything that is not `scheme://…`.
 */
export function parseLink(link: string): ParsedLink | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/.exec(link);
  if (!match) return null;
  return {
    scheme: (match[1] ?? "").toLowerCase(),
    host: match[2] ?? "",
    path: match[3] ?? "",
    search: match[4] ?? "",
  };
}

/**
 * The app's own deep link to `path`, in the scheme this build answers to. A development build has a scheme of its
 * own, so the link is asked of `expo-linking` rather than written from the configured scheme.
 */
export function appLink(path: string): string {
  return Linking.createURL(path);
}

/**
 * Open an http or https page outside the app: the system browser on a phone, where a checkout or a store page
 * must not run inside the app's own view, and a new tab on the web. Any other scheme is refused, so an address a
 * response carried cannot run script or open another app. `false` when it was refused.
 */
export async function openExternal(url: string): Promise<boolean> {
  const scheme = parseLink(url)?.scheme;
  if (scheme !== "https" && scheme !== "http") return false;
  if (onDevice()) await WebBrowser.openBrowserAsync(url);
  else await Linking.openURL(url);
  return true;
}
