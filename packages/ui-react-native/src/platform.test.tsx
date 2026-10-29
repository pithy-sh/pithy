// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { Platform } from "react-native";
import { afterEach, describe, expect, test } from "vitest";
import {
  appLink,
  devicePlatform,
  openExternal,
  parseLink,
  parseQuery,
  queryString,
  searchParam,
} from "../templates/src/platform";
import { linking } from "../testing/expo-linking";
import { webBrowser } from "../testing/expo-web-browser";

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
});

describe("a query string, read without URLSearchParams", () => {
  test("reads each parameter once, decoded, the first value winning as URLSearchParams.get answers", () => {
    expect(parseQuery("?email=ada%40example.com&next=%2Fhome&email=other")).toEqual({
      email: "ada@example.com",
      next: "/home",
    });
  });

  test("answers the same with or without the leading question mark, and for an empty one", () => {
    expect(parseQuery("a=1")).toEqual({ a: "1" });
    expect(parseQuery("")).toEqual({});
    expect(parseQuery("?")).toEqual({});
  });

  test("reads a plus as a space, as a form-encoded query means it", () => {
    expect(searchParam("?name=Ada+Lovelace", "name")).toBe("Ada Lovelace");
  });

  test("a key with no value is the empty string, and an absent key is null", () => {
    expect(searchParam("?flag&x=1", "flag")).toBe("");
    expect(searchParam("?x=1", "missing")).toBeNull();
  });

  test("a malformed escape does not throw; the raw text is kept", () => {
    expect(searchParam("?bad=%zz", "bad")).toBe("%zz");
  });

  test("writes a query back, empty when there is nothing to write", () => {
    expect(queryString({ email: "ada@example.com", next: "/a b" })).toBe("?email=ada%40example.com&next=%2Fa%20b");
    expect(queryString({})).toBe("");
  });
});

describe("a deep link, read without URL", () => {
  test("splits a custom-scheme link into its parts", () => {
    expect(parseLink("myapp://callback?code=abc#frag")).toEqual({
      scheme: "myapp",
      host: "callback",
      path: "",
      search: "?code=abc",
    });
  });

  test("splits an https universal link", () => {
    expect(parseLink("https://app.example.com/payments/return?session=cs_1")).toEqual({
      scheme: "https",
      host: "app.example.com",
      path: "/payments/return",
      search: "?session=cs_1",
    });
  });

  test("a scheme-less string is not a link", () => {
    expect(parseLink("/callback?code=1")).toBeNull();
    expect(parseLink("not a link")).toBeNull();
  });

  test("lower-cases the scheme, which RFC 3986 makes case-insensitive", () => {
    expect(parseLink("MyApp://x")?.scheme).toBe("myapp");
  });
});

describe("leaving the app", () => {
  test("on a phone an https page opens in the system browser", async () => {
    Platform.OS = "ios";
    expect(await openExternal("https://checkout.example.com/c/1")).toBe(true);
    expect(webBrowser.opened).toEqual(["https://checkout.example.com/c/1"]);
  });

  test("on the web it opens through Linking", async () => {
    Platform.OS = "web";
    expect(await openExternal("https://checkout.example.com/c/1")).toBe(true);
    expect(webBrowser.opened).toEqual([]);
  });

  test("a URL that is not http or https is refused, wherever the app runs", async () => {
    for (const platform of ["ios", "web"] as const) {
      Platform.OS = platform;
      expect(await openExternal("javascript:alert(1)")).toBe(false);
      expect(await openExternal("myapp://elsewhere")).toBe(false);
    }
    expect(webBrowser.opened).toEqual([]);
  });

  test("the app's own deep link comes from expo-linking, so a dev build gets its dev scheme", () => {
    linking.scheme = "exp+demo";
    expect(appLink("/callback")).toBe("exp+demo://callback");
  });
});

describe("the platform a device registers as", () => {
  test("is the platform React Native names, and the web for anything else", () => {
    Platform.OS = "android";
    expect(devicePlatform()).toBe("android");
    Platform.OS = "ios";
    expect(devicePlatform()).toBe("ios");
    Platform.OS = "web";
    expect(devicePlatform()).toBe("web");
    (Platform as { OS: string }).OS = "windows";
    expect(devicePlatform()).toBe("web");
  });
});
