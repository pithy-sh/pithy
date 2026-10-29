// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import type { AuthFetch, AuthRequestInit } from "./api";
import {
  createHandoffVerifier,
  exchangeHandoff,
  type HandoffCrypto,
  handoffCallbackURL,
  handoffCode,
  nativeSignInStartURL,
} from "./handoff";

/** RFC 7636 appendix B: the 32 random octets, the verifier they encode to, and its S256 challenge. */
const RFC_OCTETS = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
  88, 5, 88, 83, 132, 141, 121,
];
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/** The web's crypto, as a browser or react-native-web hands it over. */
const webCrypto: HandoffCrypto = {
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  sha256: (data) => crypto.subtle.digest("SHA-256", new Uint8Array(data)),
};

interface Call {
  url: string;
  init: AuthRequestInit | undefined;
}

function answering(status: number, body: unknown, calls: Call[] = []): AuthFetch {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
}

describe("handoffCode", () => {
  test("reads the code off the deep link a redirect sign-in returned to", () => {
    expect(handoffCode("myapp://auth/callback?code=abc_DEF-123")).toBe("abc_DEF-123");
  });

  test("a link with no code, or an error instead, answers null", () => {
    expect(handoffCode("myapp://auth/callback")).toBeNull();
    expect(handoffCode("myapp://auth/callback?error=provider_sign_in_refused")).toBeNull();
    expect(handoffCode("not a url")).toBeNull();
    expect(handoffCode("myapp://auth/callback?code=")).toBeNull();
    expect(handoffCode("myapp://auth/callback?code")).toBeNull();
  });

  test("reads the code off an https universal link or app link", () => {
    expect(handoffCode("https://app.example.test/auth/callback?code=abc_DEF-123")).toBe("abc_DEF-123");
    expect(handoffCode("https://app.example.test/auth/callback?next=%2Fhome&code=abc")).toBe("abc");
  });

  test("decodes a percent-encoded value and a plus as a space, as a query string means them", () => {
    expect(handoffCode("myapp://auth/callback?code=a%2Bb%2Fc%3D")).toBe("a+b/c=");
    expect(handoffCode("myapp://auth/callback?code=a+b")).toBe("a b");
    expect(handoffCode("myapp://auth/callback?c%6Fde=named-encoded")).toBe("named-encoded");
  });

  test("takes the first code, ignores the fragment, and never reads a parameter that merely ends in code", () => {
    expect(handoffCode("myapp://auth/callback?code=first&code=second")).toBe("first");
    expect(handoffCode("myapp://auth/callback?code=abc#code=fragment")).toBe("abc");
    expect(handoffCode("myapp://auth/callback#code=fragment-only")).toBeNull();
    expect(handoffCode("myapp://auth/callback#section?code=in-the-fragment")).toBeNull();
    expect(handoffCode("myapp://auth/callback?promo_code=nope")).toBeNull();
    expect(handoffCode("myapp://auth/callback?error=x&code=abc")).toBe("abc");
  });

  test("a value that is not valid percent-encoding answers null rather than throwing", () => {
    expect(handoffCode("myapp://auth/callback?code=%E0%A4%A")).toBeNull();
  });

  test("needs no URL global, as on a React Native runtime whose URL has no searchParams", () => {
    const original = globalThis.URL;
    try {
      Reflect.deleteProperty(globalThis, "URL");
      expect(typeof globalThis.URL).toBe("undefined");
      expect(handoffCode("myapp://auth/callback?code=abc")).toBe("abc");
      expect(handoffCode("https://app.example.test/auth/callback?code=a%2Bb")).toBe("a+b");
    } finally {
      globalThis.URL = original;
    }
  });
});

describe("exchangeHandoff", () => {
  test("posts the code to the handoff route and answers the session token", async () => {
    const calls: Call[] = [];
    const answer = { token: "raw-session-token", expiresAt: "2026-11-04T12:00:00.000Z" };
    const result = await exchangeHandoff(
      { code: "the-code", verifier: "the-verifier" },
      { origin: "https://api.example.test", fetch: answering(200, answer, calls) },
    );
    expect(result).toEqual({ ok: true, value: answer });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.example.test/auth/handoff");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ code: "the-code", verifier: "the-verifier" });
  });

  test("a spent or expired code comes back as the kit's refusal", async () => {
    const result = await exchangeHandoff(
      { code: "spent", verifier: "v" },
      {
        fetch: answering(400, {
          error: { code: "auth/handoff_invalid", message: "That sign-in link has expired or was already used." },
        }),
      },
    );
    expect(result).toMatchObject({ ok: false, failure: { code: "auth/handoff_invalid" } });
  });

  test("an answer without a token is unreadable, never a session", async () => {
    const result = await exchangeHandoff({ code: "c", verifier: "v" }, { fetch: answering(200, { expiresAt: "x" }) });
    expect(result).toMatchObject({ ok: false, failure: { code: "client/unreadable" } });
  });
});

describe("createHandoffVerifier", () => {
  test("encodes 32 random octets as the verifier and answers its S256 challenge (RFC 7636 appendix B)", async () => {
    const asked: number[] = [];
    const pair = await createHandoffVerifier({
      randomBytes: (length) => {
        asked.push(length);
        return Uint8Array.from(RFC_OCTETS);
      },
      sha256: webCrypto.sha256,
    });
    expect(asked).toEqual([32]);
    expect(pair).toEqual({ verifier: RFC_VERIFIER, challenge: RFC_CHALLENGE });
  });

  test("hashes the verifier's ASCII bytes, not anything else", async () => {
    const hashed: string[] = [];
    await createHandoffVerifier({
      randomBytes: () => Uint8Array.from(RFC_OCTETS),
      sha256: (data) => {
        hashed.push(new TextDecoder().decode(data));
        return webCrypto.sha256(data);
      },
    });
    expect(hashed).toEqual([RFC_VERIFIER]);
  });

  test("two pairs from real randomness differ, and both have the RFC's shape", async () => {
    const first = await createHandoffVerifier(webCrypto);
    const second = await createHandoffVerifier(webCrypto);
    expect(first.verifier).not.toBe(second.verifier);
    for (const pair of [first, second]) {
      expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
  });
});

describe("handoffCallbackURL", () => {
  test("puts the challenge on the app's deep link", () => {
    expect(handoffCallbackURL("myapp://auth/callback", RFC_CHALLENGE)).toBe(
      `myapp://auth/callback?handoff_challenge=${RFC_CHALLENGE}`,
    );
  });

  test("keeps a query the link already has", () => {
    expect(handoffCallbackURL("myapp://auth/callback?next=%2Fhome", RFC_CHALLENGE)).toBe(
      `myapp://auth/callback?next=%2Fhome&handoff_challenge=${RFC_CHALLENGE}`,
    );
  });
});

describe("nativeSignInStartURL", () => {
  const callbackURL = `myapp://auth/callback?handoff_challenge=${RFC_CHALLENGE}`;

  test("is the Worker's start route with every field encoded into the query", () => {
    const url = nativeSignInStartURL({
      origin: "https://api.example.test",
      provider: "github",
      callbackURL,
      errorCallbackURL: "myapp://sign-in?provider=github",
    });
    expect(url).toBe(
      `https://api.example.test/auth/sign-in/social/start?provider=github&callbackURL=${encodeURIComponent(callbackURL)}&errorCallbackURL=${encodeURIComponent("myapp://sign-in?provider=github")}`,
    );
    const parsed = new URL(url ?? "");
    expect(parsed.searchParams.get("callbackURL")).toBe(callbackURL);
    expect(parsed.searchParams.get("errorCallbackURL")).toBe("myapp://sign-in?provider=github");
  });

  test("follows a moved basePath, and leaves errorCallbackURL out when there is none", () => {
    expect(
      nativeSignInStartURL({ origin: "http://10.0.2.2:8787", basePath: "/identity", provider: "apple", callbackURL }),
    ).toBe(
      `http://10.0.2.2:8787/identity/sign-in/social/start?provider=apple&callbackURL=${encodeURIComponent(callbackURL)}`,
    );
  });

  test("builds nothing for an origin that is not bare, or a basePath that would leave it", () => {
    for (const input of [
      { origin: "https://api.example.test/" },
      { origin: "https://api.example.test/auth" },
      { origin: "javascript:alert(1)" },
      { origin: "https://api.example.test", basePath: "//evil.example.test" },
      { origin: "https://api.example.test", basePath: "auth" },
    ]) {
      expect(nativeSignInStartURL({ ...input, provider: "github", callbackURL }), JSON.stringify(input)).toBeNull();
    }
  });
});
