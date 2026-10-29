// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import type { RouteModule } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";

vi.mock("../templates/src/pithy-config", async (importOriginal) => {
  const { AUTH_DISABLED } = await import("@pithy-sh/ui-core/src/config");
  return {
    ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
    authConfig: { ...AUTH_DISABLED, enabled: true, otpLength: 6 },
  };
});

vi.mock("../templates/src/route-modules", () => {
  const screen = (path: string, role?: string) => async () =>
    ({ path, role, default: () => <Text>{path}</Text> }) as unknown as RouteModule;
  return {
    pithyRoutes: [
      screen("/sign-in", "sign-in"),
      screen("/account-suspended", "account-suspended"),
      screen("/invitations/:token"),
    ],
    appRoutes: [screen("/")],
    sessionModule: undefined,
    paymentsModule: undefined,
  };
});

const ORIGIN = "http://localhost:8787";

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
}

let calls: Call[] = [];
let verifyAnswer: { status: number; body: unknown };

beforeEach(() => {
  calls = [];
  verifyAnswer = { status: 200, body: { token: "otp-session", user: { id: "u1" } } };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    let status = 200;
    let body: unknown = {};
    if (url.endsWith("/sign-in/email-otp")) ({ status, body } = verifyAnswer);
    if (url.endsWith("/get-session")) body = { user: { id: "u1", email: "ada@example.com" } };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function open(platform: "ios" | "web", path = "/otp?email=ada%40example.com") {
  Platform.OS = platform;
  const router = await import("../templates/src/router");
  const otp = await import("../templates/src/routes/pithy/otp");
  const adapter = router.createMemoryAdapter(path);
  await act(async () => {
    render(
      <router.RouterProvider adapter={adapter}>
        <otp.default />
      </router.RouterProvider>,
    );
  });
  return { adapter, otp };
}

function digits(): HTMLInputElement[] {
  return screen.getAllByRole("textbox") as HTMLInputElement[];
}

function type(code: string): void {
  code.split("").forEach((digit, index) => {
    const box = digits()[index];
    if (box) fireEvent.change(box, { target: { value: digit } });
  });
}

function submit(): HTMLElement {
  const button = screen.getAllByRole("button")[0];
  if (!button) throw new Error("No submit.");
  return button;
}

describe("the code screen", () => {
  test("sits at /otp and counts the digits it asked for, to the address in the query", async () => {
    const { otp } = await open("web");
    expect(otp.path).toBe("/otp");
    expect(screen.getByText("We sent 6 digits to ada@example.com.")).toBeTruthy();
    expect(digits()).toHaveLength(6);
  });

  test("says your inbox with no address", async () => {
    await open("web", "/otp");
    expect(screen.getByText("We sent 6 digits to your inbox.")).toBeTruthy();
  });

  test("keeps the submit shut until every digit is in, and drops anything but digits", async () => {
    await open("web");
    type("12a45");
    expect(digits().map((box) => box.value)).toEqual(["1", "2", "", "4", "5", ""]);
    expect(submit().getAttribute("aria-disabled")).toBe("true");
  });

  test("a code pasted or filled in whole lands across the row", async () => {
    await open("web");
    const first = digits()[0];
    if (first) fireEvent.change(first, { target: { value: "654321" } });
    expect(digits().map((box) => box.value)).toEqual(["6", "5", "4", "3", "2", "1"]);
  });

  test("on a phone, a right code's session is adopted into the secure store and the app goes home", async () => {
    const { adapter } = await open("ios");
    type("123456");
    await act(async () => {
      fireEvent.click(submit());
    });
    await waitFor(() => expect(adapter.path()).toBe("/"));
    const verify = calls.find((call) => call.url === `${ORIGIN}/auth/sign-in/email-otp`);
    expect(JSON.parse(String(verify?.init.body))).toEqual({ email: "ada@example.com", otp: "123456" });
    expect(verify?.init.headers?.["x-pithy-platform"]).toBe("ios");
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("otp-session");
  });

  test("on a phone, an invitation that sent somebody to sign in is where the app goes, not a browser", async () => {
    const { adapter } = await open("ios", "/otp?email=ada%40example.com&resume=%2Finvitations%2Ftok_1");
    type("123456");
    await act(async () => {
      fireEvent.click(submit());
    });
    await waitFor(() => expect(adapter.path()).toBe("/invitations/tok_1"));
    expect(webBrowser.opened).toEqual([]);
  });

  test("on the web, a right code goes home on the cookie", async () => {
    const { adapter } = await open("web");
    type("123456");
    await act(async () => {
      fireEvent.click(submit());
    });
    await waitFor(() => expect(adapter.path()).toBe("/"));
    expect(calls.find((call) => call.url === "/auth/sign-in/email-otp")?.init.credentials).toBe("include");
  });

  test("a suspended account's right code goes on to the suspended screen, not to 'that code didn't work'", async () => {
    verifyAnswer = { status: 403, body: { error: { code: "auth/account_suspended", message: "No.", action: null } } };
    const { adapter } = await open("ios");
    type("123456");
    await act(async () => {
      fireEvent.click(submit());
    });
    await waitFor(() => expect(adapter.path()).toBe("/account-suspended"));
    expect(screen.queryByText(/didn't work/)).toBeNull();
  });

  test("a wrong code is still a wrong code", async () => {
    verifyAnswer = { status: 400, body: { code: "INVALID_OTP", message: "Invalid OTP" } };
    const { adapter } = await open("ios");
    type("000000");
    await act(async () => {
      fireEvent.click(submit());
    });
    expect(await screen.findByText("That code didn't work. Try again, or send a new one.")).toBeTruthy();
    expect(adapter.path()).toBe("/otp?email=ada%40example.com");
  });

  test("a new code is sent through the send route, to the same address", async () => {
    await open("ios");
    const resend = screen.getByText("Send a new code");
    await act(async () => {
      fireEvent.click(resend);
    });
    const send = calls.find((call) => call.url === `${ORIGIN}/auth/email-otp/send-verification-otp`);
    expect(JSON.parse(String(send?.init.body))).toEqual({ email: "ada@example.com", type: "sign-in" });
  });
});
