// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { decodeAttestation } from "@pithy-sh/auth/src/attestation/wire";
import { TURNSTILE_WIDGET_PATH } from "@pithy-sh/turnstile/src/http/widgetPage";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { appIntegrity } from "../testing/expo-app-integrity";
import { webViews } from "../testing/react-native-webview";

/**
 * The scaffolded app's attestation, through the real sign-in and code screens: what each platform sends in each
 * mode, where Turnstile stays, and what a refused send shows.
 */

const config = vi.hoisted(() => ({
  attestation: undefined as { mode: "enforce" | "test"; platforms?: { ios: boolean; android: boolean } } | undefined,
  playIntegrityProject: null as string | null,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => {
  const { AUTH_DISABLED } = await import("@pithy-sh/ui-core/src/config");
  return {
    ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
    get authConfig() {
      return {
        ...AUTH_DISABLED,
        enabled: true,
        providers: {},
        signUpEnabled: true,
        ...(config.attestation ? { attestation: config.attestation } : {}),
      };
    },
    get turnstileConfig() {
      return {
        enabled: true,
        sitekey: "1x00000000000000000000AA",
        action: "login",
        mode: "visible",
        token: { field: "cf-turnstile-response", header: null },
      };
    },
    get playIntegrityProject() {
      return config.playIntegrityProject;
    },
  };
});

interface Call {
  url: string;
  headers: Record<string, string>;
  body: string;
}

let calls: Call[] = [];
let refusal: { status: number; body: unknown } | null = null;

beforeEach(() => {
  calls = [];
  refusal = null;
  config.attestation = undefined;
  config.playIntegrityProject = null;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit & { headers?: Record<string, string> }) => {
    calls.push({ url, headers: init.headers ?? {}, body: String(init.body ?? "") });
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/attestation/challenge"))
      return json(200, { challenge: "the-challenge", expiresAt: "2999-01-01" });
    if (refusal && (url.endsWith("/sign-in/magic-link") || url.endsWith("/send-verification-otp"))) {
      return json(refusal.status, refusal.body);
    }
    return json(200, {});
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

/** Render the sign-in screen on `platform`, with every module read after the platform is set. */
async function openSignIn(platform: "ios" | "android" | "web"): Promise<void> {
  Platform.OS = platform;
  const router = await import("../templates/src/router");
  const signIn = await import("../templates/src/routes/pithy/sign-in");
  await act(async () => {
    render(
      <router.RouterProvider adapter={router.createMemoryAdapter("/sign-in")}>
        <signIn.default />
      </router.RouterProvider>,
    );
  });
}

/** Type an address and press the email button, whichever the screen offers, and wait for the send to settle. */
async function send(): Promise<void> {
  const before = calls.length;
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
  const button =
    screen.queryByRole("button", { name: "Email me a code" }) ??
    screen.getByRole("button", { name: "Email me a link" });
  await act(async () => {
    fireEvent.click(button);
  });
  await waitFor(() => {
    const settled =
      calls.slice(before).some((call) => /\/(send-verification-otp|magic-link)$/.test(call.url)) ||
      screen.queryByTestId("gate-refusal") !== null;
    expect(settled).toBe(true);
  });
}

/** The widget page posting a token, as Cloudflare's widget does once it is solved. */
async function solveTurnstile(): Promise<void> {
  const { origin } = await import("../templates/src/pithy-config");
  await act(async () => {
    webViews.last().onMessage?.({
      nativeEvent: {
        url: `${origin}${TURNSTILE_WIDGET_PATH}`,
        data: JSON.stringify({ type: "turnstile", token: "tok" }),
      },
    });
  });
}

/** The last gated send the screen made, and its attestation decoded. */
function sent() {
  const call = calls
    .filter((each) => each.url.endsWith("/send-verification-otp") || each.url.endsWith("/magic-link"))
    .at(-1);
  const header = call?.headers["x-pithy-attestation"];
  return { call, attestation: header === undefined ? undefined : decodeAttestation(header) };
}

describe("in a test environment, a simulator and an emulator", () => {
  for (const platform of ["ios", "android"] as const) {
    test(`on ${platform}, send the test assertion over a fresh challenge, with no WebView`, async () => {
      config.attestation = { mode: "test" };
      await openSignIn(platform);
      expect(webViews.mounted).toEqual([]);
      await send();
      const { call, attestation } = sent();
      expect(calls[0]?.url.endsWith("/auth/attestation/challenge")).toBe(true);
      expect(attestation).toEqual({
        ok: true,
        value: { platform, challenge: "the-challenge", assertion: "pithy-test-attestation" },
      });
      expect(JSON.parse(call?.body ?? "{}")).not.toHaveProperty("cf-turnstile-response");
      expect(appIntegrity.calls).toEqual([]);
    });
  }
});

describe("in an enforcing environment", () => {
  test("an iPhone registers an App Attest key over the challenge and the exact body", async () => {
    config.attestation = { mode: "enforce" };
    await openSignIn("ios");
    expect(webViews.mounted).toEqual([]);
    await send();
    const { call, attestation } = sent();
    expect(attestation).toEqual({
      ok: true,
      value: {
        platform: "ios",
        challenge: "the-challenge",
        assertion: "attestation-object-for-app-attest-key-1",
        keyId: "app-attest-key-1",
      },
    });
    expect(appIntegrity.calls).toEqual([
      "generateKeyAsync -> app-attest-key-1",
      `attestKeyAsync app-attest-key-1 the-challenge${call?.body}`,
    ]);
  });

  test("an iPhone without App Attest keeps Turnstile", async () => {
    config.attestation = { mode: "enforce" };
    appIntegrity.supported = false;
    await openSignIn("ios");
    expect(webViews.mounted).toHaveLength(1);
  });

  test("Android asks Play Integrity for a token bound to the request, for the configured project", async () => {
    config.attestation = { mode: "enforce" };
    config.playIntegrityProject = "123456789";
    await openSignIn("android");
    expect(webViews.mounted).toEqual([]);
    await send();
    const { attestation } = sent();
    expect(attestation?.ok && attestation.value.platform).toBe("android");
    expect(attestation?.ok && attestation.value.assertion).toMatch(/^integrity-token-for-[A-Za-z0-9_-]{43}$/);
    expect(appIntegrity.calls[0]).toBe("prepareIntegrityTokenProviderAsync 123456789");
  });

  for (const platform of ["ios", "android"] as const) {
    test(`on ${platform}, a block that allows no ${platform} app keeps Turnstile instead of a refused attestation`, async () => {
      config.attestation = { mode: "enforce", platforms: { ios: platform !== "ios", android: platform !== "android" } };
      config.playIntegrityProject = "123456789";
      await openSignIn(platform);
      expect(webViews.mounted).toHaveLength(1);
      await solveTurnstile();
      await send();
      const { call, attestation } = sent();
      expect(attestation).toBeUndefined();
      expect(JSON.parse(call?.body ?? "{}")).toHaveProperty("cf-turnstile-response", "tok");
      expect(calls.some((each) => each.url.endsWith("/attestation/challenge"))).toBe(false);
      expect(appIntegrity.calls).toEqual([]);
    });
  }

  test("a platform the block allows attests, beside one it does not", async () => {
    config.attestation = { mode: "enforce", platforms: { ios: true, android: false } };
    await openSignIn("ios");
    expect(webViews.mounted).toEqual([]);
  });

  test("Android with no project number keeps Turnstile", async () => {
    config.attestation = { mode: "enforce" };
    await openSignIn("android");
    expect(webViews.mounted).toHaveLength(1);
  });
});

describe("Turnstile stays", () => {
  test("in the web build, whatever the environment's attestation", async () => {
    config.attestation = { mode: "test" };
    await openSignIn("web");
    expect(screen.getByTestId("turnstile")).toBeTruthy();
    expect(webViews.mounted).toEqual([]);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    // The link stays shut until the widget answers: the send waits on Turnstile, not on an attestation.
    expect(screen.getByRole("button", { name: "Email me a link" }).getAttribute("aria-disabled")).toBe("true");
    expect(calls).toEqual([]);
  });

  test("on a phone, in an environment with no attestation block", async () => {
    await openSignIn("ios");
    expect(webViews.mounted).toHaveLength(1);
  });
});

describe("a refused send shows the gate's code, not a bare 403", () => {
  const cases = [
    {
      code: "turnstile/failed",
      status: 403,
      message: "The humanity check failed.",
      attestation: undefined,
      platform: "ios" as const,
    },
    {
      code: "auth/attestation_failed",
      status: 403,
      message: "The app's attestation did not verify. Ask for a new challenge and try again.",
      attestation: { mode: "test" as const },
      platform: "android" as const,
    },
  ];
  for (const refused of cases) {
    test(refused.code, async () => {
      config.attestation = refused.attestation;
      refusal = { status: refused.status, body: { error: { code: refused.code, message: refused.message } } };
      await openSignIn(refused.platform);
      if (refused.attestation === undefined) await solveTurnstile();
      await send();
      const shown = await waitFor(() => screen.getByTestId("gate-refusal"));
      expect(shown.textContent).toContain(refused.code);
      expect(screen.queryByRole("heading", { name: "Check your inbox." })).toBeNull();
    });
  }

  test("an iPhone whose App Attest key was refused drops it, and registers a new one next time", async () => {
    config.attestation = { mode: "enforce" };
    refusal = { status: 403, body: { error: { code: "auth/attestation_failed", message: "No." } } };
    await openSignIn("ios");
    await send();
    expect((await waitFor(() => screen.getByTestId("gate-refusal"))).textContent).toContain("auth/attestation_failed");
    refusal = null;
    await send();
    await waitFor(() =>
      expect(appIntegrity.calls.filter((line) => line.startsWith("generateKeyAsync"))).toHaveLength(2),
    );
  });

  test("a device that cannot attest says so, nothing is sent, and the screen offers Turnstile instead", async () => {
    config.attestation = { mode: "enforce" };
    appIntegrity.failing = new Error("featureUnsupported");
    await openSignIn("ios");
    expect(webViews.mounted).toEqual([]);
    await send();
    expect((await waitFor(() => screen.getByTestId("gate-refusal"))).textContent).toContain(
      "client/attestation_unavailable",
    );
    expect(sent().call).toBeUndefined();
    // The Worker judges a send with no attestation header by Turnstile, so the widget is the way through.
    expect(webViews.mounted.length).toBeGreaterThan(0);
    await solveTurnstile();
    await send();
    const { call, attestation } = sent();
    expect(attestation).toBeUndefined();
    expect(JSON.parse(call?.body ?? "{}")).toHaveProperty("cf-turnstile-response", "tok");
  });

  test("an Android phone whose Play Integrity provider will not prepare falls back to Turnstile on the code screen too", async () => {
    config.attestation = { mode: "enforce" };
    config.playIntegrityProject = "123456789";
    appIntegrity.failing = new Error("PLAY_SERVICES_NOT_FOUND");
    await openSignIn("android");
    await send();
    expect((await waitFor(() => screen.getByTestId("gate-refusal"))).textContent).toContain(
      "client/attestation_unavailable",
    );
    cleanup();
    await openOtpLoaded("android");
    expect(webViews.mounted.length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Send a new code" }).getAttribute("aria-disabled")).toBe("true");
  });
});

/** Render the code screen on `platform` for a held address, with every module read after the platform is set. */
async function openOtp(platform: "ios" | "android"): Promise<void> {
  Platform.OS = platform;
  await openOtpLoaded(platform);
}

/** Render the code screen with the modules already loaded, as navigating from the sign-in screen does. */
async function openOtpLoaded(platform: "ios" | "android"): Promise<void> {
  Platform.OS = platform;
  const session = await import("../templates/src/session");
  session.holdOtpAddress("ada@example.com");
  const router = await import("../templates/src/router");
  const otp = await import("../templates/src/routes/pithy/otp");
  await act(async () => {
    render(
      <router.RouterProvider adapter={router.createMemoryAdapter("/otp")}>
        <otp.default />
      </router.RouterProvider>,
    );
  });
}

/** Press "Send a new code" and wait for the send to land. */
async function resend(): Promise<void> {
  const before = calls.length;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
  });
  await waitFor(() =>
    expect(calls.slice(before).some((call) => call.url.endsWith("/send-verification-otp"))).toBe(true),
  );
}

describe("the code screen's resend", () => {
  for (const platform of ["ios", "android"] as const) {
    test(`on ${platform} in a test environment, attests with no WebView and waits on no token`, async () => {
      config.attestation = { mode: "test" };
      await openOtp(platform);
      expect(webViews.mounted).toEqual([]);
      expect(screen.getByRole("button", { name: "Send a new code" }).getAttribute("aria-disabled")).not.toBe("true");
      await resend();
      const { call, attestation } = sent();
      expect(attestation).toEqual({
        ok: true,
        value: { platform, challenge: "the-challenge", assertion: "pithy-test-attestation" },
      });
      expect(JSON.parse(call?.body ?? "{}")).not.toHaveProperty("cf-turnstile-response");
      expect(screen.queryByTestId("gate-refusal")).toBeNull();
    });
  }

  test("with no attestation block, keeps Turnstile and waits on its token", async () => {
    await openOtp("ios");
    expect(webViews.mounted).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send a new code" }).getAttribute("aria-disabled")).toBe("true");
    await solveTurnstile();
    expect(screen.getByRole("button", { name: "Send a new code" }).getAttribute("aria-disabled")).not.toBe("true");
  });

  const refusals = [
    { code: "turnstile/failed", attestation: undefined },
    { code: "auth/attestation_failed", attestation: { mode: "test" as const } },
  ];
  for (const refused of refusals) {
    test(`a resend refused with ${refused.code} shows the code, and a resend that passes clears it`, async () => {
      config.attestation = refused.attestation;
      refusal = { status: 403, body: { error: { code: refused.code, message: "Refused." } } };
      await openOtp("android");
      if (refused.attestation === undefined) await solveTurnstile();
      await resend();
      expect((await waitFor(() => screen.getByTestId("gate-refusal"))).textContent).toContain(refused.code);
      refusal = null;
      await resend();
      await waitFor(() => expect(screen.queryByTestId("gate-refusal")).toBeNull());
    });
  }
});
