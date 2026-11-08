import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { secureStore } from "@pithy-sh/ui-react-native/testing/expo-secure-store";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// The sign-in screen, rendered on the web and on a phone. `vitest.config.ts` renders React Native through
// `react-native-web` and swaps every native module for a stand-in from `@pithy-sh/ui-react-native/testing`.
// Import a stand-in by that path to drive it: `secureStore` below is the Keychain this screen's session reads, and
// every stand-in starts each test empty. The Worker is a stubbed `fetch`, so nothing leaves the machine.

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    sent.push({ url, headers, body: init.body ? JSON.parse(String(init.body)) : {} });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  // Each test reads `Platform.OS` afresh, so the screen and everything it imports load again.
  vi.resetModules();
});

/** Render the sign-in screen on `platform`, and ask for a sign-in by email. */
async function signInOn(platform: "web" | "ios", button: string) {
  Platform.OS = platform;
  const router = await import("../../router");
  const signIn = await import("./sign-in");
  const adapter = router.createMemoryAdapter(signIn.path);
  await act(async () => {
    render(
      <router.RouterProvider adapter={adapter}>
        <signIn.default />
      </router.RouterProvider>,
    );
  });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: button }));
  });
  return adapter;
}

test("on the web, the link is mailed from this origin and comes back to it", async () => {
  await signInOn("web", "Email me a link");
  await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Check your inbox."));
  const link = sent.find((request) => request.url.endsWith("/sign-in/magic-link"));
  expect(link?.url.startsWith("/")).toBe(true);
  expect(link?.body).toMatchObject({ email: "ada@example.com", callbackURL: "/callback" });
  expect(link?.headers.authorization).toBeUndefined();
  // The web build's session is the page's cookie: nothing is kept on the device.
  expect(secureStore.items.size).toBe(0);
});

test("on a phone, the code goes to the Worker's origin with the session the secure store holds", async () => {
  const { origin } = await import("../../pithy-config");
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "held-session", expiresAt: null }));
  const adapter = await signInOn("ios", "Email me a code");
  await waitFor(() => expect(adapter.path()).toBe("/otp"));
  const code = sent.find((request) => request.url.endsWith("/email-otp/send-verification-otp"));
  expect(code?.url.startsWith(`${origin}/`)).toBe(true);
  expect(code?.headers.authorization).toBe("Bearer held-session");
  expect(code?.body).toMatchObject({ email: "ada@example.com", type: "sign-in" });
});
