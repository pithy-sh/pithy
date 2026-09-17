// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { describe, expect, test } from "vitest";
import { guardErrorCallbackURL, normalizeErrorCallbackURL } from "./errorCallbackUrl";

/**
 * The input guard on `errorCallbackURL` (#625).
 *
 * The end-to-end proof lives in `providerRefusal.workers.test.ts`, which drives a real refused callback
 * over real D1 and diffs what leaves the Worker. This file is the shape table: every input shape, one
 * line each, because the defect this guard closes *is* a shape nobody enumerated — two rounds of
 * output-side repair were each bypassed by an input nobody had written down.
 *
 * **The concatenation is modeled here and nowhere else.** `redirectOnError` is one line
 * (`better-auth/dist/api/routes/callback.mjs:78`); `appendLikeBetterAuth` reproduces it so the cases can
 * assert the *consequence* of a normalized value rather than restate the rule that produced it. The guard
 * itself does not contain this model, deliberately — a guard that reasons about what a dependency will do
 * with a string is the thing #625's third round exists to stop relying on.
 */

/** The callback this Worker is answering. A root-relative input resolves against it for parsing. */
const REQUEST = "https://auth.example/auth/sign-in/social";

/** `redirectOnError`, verbatim. Not imported — the dependency does not export it. */
function appendLikeBetterAuth(errorURL: string, code: string): string {
  const params = new URLSearchParams({ error: code });
  return `${errorURL}${errorURL.includes("?") ? "&" : "?"}${params.toString()}`;
}

/** What a browser would read out of that concatenation, which is the only thing the attack is about. */
function errorsIn(location: string): string[] {
  return new URL(location, REQUEST).searchParams.getAll("error");
}

describe("a value the guard accepts is one the refusal can be appended to", () => {
  const ACCEPTED = [
    { label: "an absolute URL", value: "https://app.example/sign-in", normalized: "https://app.example/sign-in" },
    {
      label: "an absolute URL with a query",
      value: "https://app.example/sign-in?provider=github",
      normalized: "https://app.example/sign-in?provider=github",
    },
    {
      label: "an absolute URL with an empty trailing query separator",
      // Harmless on its own — `?&error=x` still reads — but the kit does not produce it, so it does not
      // survive normalization either. The value handed on carries a `?` exactly when it carries a query.
      value: "https://app.example/sign-in?",
      normalized: "https://app.example/sign-in",
    },
    {
      label: "an absolute URL with dot segments",
      value: "https://app.example/app/../sign-in",
      normalized: "https://app.example/sign-in",
    },
    { label: "a root-relative path", value: "/sign-in", normalized: "/sign-in" },
    {
      label: "a root-relative path with a query",
      value: "/sign-in?provider=github",
      normalized: "/sign-in?provider=github",
    },
    {
      label: "a literal `#` that was percent-encoded, which is not a fragment",
      value: "https://app.example/sign-in%23one",
      normalized: "https://app.example/sign-in%23one",
    },
  ] as const;

  test.each(ACCEPTED)("$label is normalized to the value it names", ({ value, normalized }) => {
    expect(normalizeErrorCallbackURL(value, REQUEST)).toBe(normalized);
  });

  test.each(ACCEPTED)("$label answers exactly one readable error once appended to", ({ value }) => {
    // The invariant, measured through the dependency's own concatenation rather than restated.
    const location = appendLikeBetterAuth(normalizeErrorCallbackURL(value, REQUEST), "account_not_linked");
    expect(errorsIn(location)).toEqual(["account_not_linked"]);
  });

  test("a root-relative path stays root-relative, and never acquires this Worker's origin", () => {
    // The adopter's error screen is not necessarily served from here. Resolving `/sign-in` to
    // `https://auth.example/sign-in` would silently retarget it at the Worker.
    expect(normalizeErrorCallbackURL("/sign-in?provider=github", REQUEST)).toBe("/sign-in?provider=github");
  });
});

describe("a value the guard refuses is one the refusal cannot be appended to", () => {
  const REFUSED = [
    {
      label: "a fragment",
      // The bypass itself. What it would have done is measured below, in its own describe.
      value: "https://app.example/sign-in#x",
      why: "fragment",
    },
    {
      label: "a bare trailing `#`, whose `URL.hash` is empty and which is the same bypass",
      value: "https://app.example/sign-in#",
      why: "fragment",
    },
    {
      label: "a fragment after a query",
      value: "https://app.example/sign-in?p=github#x",
      why: "fragment",
    },
    {
      label: "a root-relative path with a fragment",
      value: "/sign-in#x",
      why: "fragment",
    },
    {
      label: "an `error` parameter already on it",
      value: "https://app.example/sign-in?error=access_denied",
      why: "`error` or `error_description`",
    },
    {
      label: "a percent-encoded `error` key, which decodes to the same parameter",
      value: "https://app.example/sign-in?%65rror=access_denied",
      why: "`error` or `error_description`",
    },
    {
      label: "an `error_description` already on it",
      value: "https://app.example/sign-in?error_description=Anything.",
      why: "`error` or `error_description`",
    },
    {
      label: "a protocol-relative URL, which is another origin wearing a path's clothes",
      value: "//evil.example/x",
      why: "neither an absolute URL nor a root-relative path",
    },
    {
      label: "a bare-relative path, which resolves against whatever happens to be parsing it",
      value: "sign-in?provider=github",
      why: "neither an absolute URL nor a root-relative path",
    },
    {
      label: "an empty string, which Better Auth stores and then concatenates onto nothing",
      value: "",
      why: "empty",
    },
  ] as const;

  test.each(REFUSED)("$label is refused, naming the field and the property", ({ value, why }) => {
    let thrown: unknown;
    try {
      normalizeErrorCallbackURL(value, REQUEST);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, `${JSON.stringify(value)} was accepted`).toBeInstanceOf(PithyError);
    const payload = (thrown as PithyError).payload;
    expect(payload.status).toBe(400);
    // The adopter reads this in development, where the value is configured. It has to say which field.
    expect(payload.detail).toContain("errorCallbackURL");
    expect(payload.detail).toContain(why);
  });

  test("the refusal is a 400 that names no code the collapse would have had to catch", () => {
    // A refusal at the door says nothing about the user table, because nothing has been looked up.
    let thrown: unknown;
    try {
      normalizeErrorCallbackURL("https://app.example/sign-in#x", REQUEST);
    } catch (error) {
      thrown = error;
    }
    const payload = (thrown as PithyError).payload;
    expect(payload.message).not.toContain("account");
    expect(payload.code).toBe("validation/invalid_input");
  });
});

/**
 * The half the roster cannot see, spelled out.
 *
 * Each of these is a value `redirectOnError` would have concatenated into something
 * `collapseProviderRefusal` reads wrongly — either as no `error` at all, or as one the caller chose. They
 * are asserted here as facts about the *dependency's* behavior rather than about the guard, so a bump
 * that changes it turns this red and the argument for the guard gets re-read instead of assumed.
 */
describe("what the refused shapes would have done, had they reached the concatenation", () => {
  test("a fragment hides the appended code from every query parser", () => {
    const location = appendLikeBetterAuth("https://app.example/sign-in#x", "account_not_linked");
    expect(location).toBe("https://app.example/sign-in#x?error=account_not_linked");
    // Nothing in the query. This is exactly why the output-side collapse returned early and let the true
    // code travel — and why no audit row was written for it either.
    expect(errorsIn(location)).toEqual([]);
    expect(new URL(location).hash).toBe("#x?error=account_not_linked");
  });

  test("a bare `#` does the same, though its hash reads as empty before the append", () => {
    expect(new URL("https://app.example/sign-in#").hash).toBe("");
    expect(errorsIn(appendLikeBetterAuth("https://app.example/sign-in#", "signup_disabled"))).toEqual([]);
  });

  test("a planted `error` puts the caller's value first, where `get` reads it", () => {
    const location = appendLikeBetterAuth("https://app.example/sign-in?error=access_denied", "account_not_linked");
    expect(new URL(location).searchParams.get("error")).toBe("access_denied");
  });
});

describe("the request handed to Better Auth", () => {
  function post(body: unknown, contentType = "application/json"): Request {
    return new Request(REQUEST, {
      method: "POST",
      headers: { "content-type": contentType, origin: "https://app.example" },
      body: JSON.stringify(body),
    });
  }

  test("is the same object when nothing needs normalizing, so no body is rebuilt", async () => {
    const request = post({ provider: "github", errorCallbackURL: "https://app.example/sign-in" });
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });

  test("is the same object when the body names no errorCallbackURL at all", async () => {
    const request = post({ provider: "github", callbackURL: "https://app.example/app" });
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });

  test("carries the normalized value, and every other field untouched", async () => {
    const guarded = await guardErrorCallbackURL(
      post({ provider: "github", callbackURL: "https://app.example/app", errorCallbackURL: "https://app.example/x?" }),
      REQUEST,
    );
    expect(await guarded.json()).toEqual({
      provider: "github",
      callbackURL: "https://app.example/app",
      errorCallbackURL: "https://app.example/x",
    });
  });

  test("keeps the headers the origin check reads, and drops the stale length", async () => {
    const request = new Request(REQUEST, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example", "content-length": "9999" },
      body: JSON.stringify({ errorCallbackURL: "https://app.example/x?" }),
    });
    const guarded = await guardErrorCallbackURL(request, REQUEST);
    expect(guarded.headers.get("origin")).toBe("https://app.example");
    expect(guarded.headers.get("content-length")).toBeNull();
  });

  test("leaves the original body readable, because the guard reads a clone", async () => {
    const request = post({ errorCallbackURL: "https://app.example/sign-in" });
    await guardErrorCallbackURL(request, REQUEST);
    expect(await request.json()).toEqual({ errorCallbackURL: "https://app.example/sign-in" });
  });

  test("refuses the fragment the collapse could not see", async () => {
    await expect(
      guardErrorCallbackURL(post({ provider: "github", errorCallbackURL: "https://app.example/sign-in#x" }), REQUEST),
    ).rejects.toBeInstanceOf(PithyError);
  });

  test("is left alone on a GET, which carries no body to guard", async () => {
    const request = new Request(`${REQUEST}?errorCallbackURL=https://app.example/sign-in%23x`);
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });

  test("is left alone when the body is not JSON", async () => {
    // A form post under `basePath` is Better Auth's to parse, in its own shape.
    const request = new Request(REQUEST, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "errorCallbackURL=https%3A%2F%2Fapp.example%2Fsign-in%23x",
    });
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });

  test("is left alone when the field is present but not a string — Better Auth already refuses that", async () => {
    const request = post({ errorCallbackURL: 7 });
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });

  test("is left alone when the body will not parse", async () => {
    const request = new Request(REQUEST, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"errorCallbackURL": ',
    });
    expect(await guardErrorCallbackURL(request, REQUEST)).toBe(request);
  });
});
