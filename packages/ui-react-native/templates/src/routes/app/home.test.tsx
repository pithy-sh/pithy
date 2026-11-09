import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import type { RouteModule } from "@pithy-sh/ui-core/src/routes";
import { secureStore } from "@pithy-sh/ui-react-native/testing/expo-secure-store";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Your home screen, rendered on the web and on a phone. `vitest.config.ts` renders React Native through
// `react-native-web` and swaps every native module for a stand-in from `@pithy-sh/ui-react-native/testing`.
// Import a stand-in by that path to drive it: `secureStore` below is the Keychain a phone keeps its session in, and
// every stand-in starts each test empty. The Worker is a stubbed `fetch`, so nothing leaves the machine.

// The session is read only while auth is composed, which is what this screen is written for.
vi.mock("../../pithy-config", async (importOriginal) => {
  const config = await importOriginal<typeof import("../../pithy-config")>();
  return { ...config, authConfig: { ...config.authConfig, enabled: true } };
});

// Screens register through Metro, which a test does not run, so the one this screen leaves for is registered here.
vi.mock("../../route-modules", () => ({
  pithyRoutes: [async () => ({ path: "/sign-in", role: "sign-in", default: () => null }) as unknown as RouteModule],
  appRoutes: [],
  sessionModule: undefined,
  paymentsModule: undefined,
  storeTransactions: undefined,
}));

interface Sent {
  url: string;
  headers: Record<string, string>;
}

let sent: Sent[] = [];
/** Whether the Worker can take a sign-out. When it can, the session it reads afterwards is nobody's. */
let workerUp = true;

beforeEach(() => {
  sent = [];
  workerUp = true;
  let signedIn = true;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    sent.push({ url, headers });
    if (url.endsWith("/sign-out")) {
      if (!workerUp) throw new TypeError("Failed to fetch");
      signedIn = false;
    }
    const session = signedIn ? { user: { id: "u1", email: "ada@example.com" } } : null;
    const body = url.endsWith("/get-session") ? session : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
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

/** Render the home screen on `platform`, once it has read who is signed in. */
async function openOn(platform: "web" | "ios") {
  Platform.OS = platform;
  const router = await import("../../router");
  const home = await import("./home");
  const adapter = router.createMemoryAdapter(home.path);
  await act(async () => {
    render(
      <router.RouterProvider adapter={adapter}>
        <home.default />
      </router.RouterProvider>,
    );
  });
  await waitFor(() => expect(screen.getByText("Signed in as ada@example.com.")).toBeTruthy());
  return { adapter, home };
}

test("asks for a session, so a signed-out visitor is sent to sign in", async () => {
  const home = await import("./home");
  expect(home.session).toBe("required");
});

test("on the web, the session is the page's cookie, and signing out goes to the sign-in screen", async () => {
  const { adapter } = await openOn("web");
  expect(sent.find((request) => request.url.endsWith("/get-session"))?.headers.authorization).toBeUndefined();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  });
  await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
  expect(sent.some((request) => request.url.endsWith("/sign-out"))).toBe(true);
  expect(secureStore.items.size).toBe(0);
});

test("on the web, a sign-out the Worker can't take leaves you on the screen, and says you're still signed in", async () => {
  const { adapter } = await openOn("web");
  workerUp = false;
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  });
  await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/still signed in/));
  expect(adapter.path()).toBe("/");
});

test("on a phone, the session comes from the secure store, and signing out forgets it", async () => {
  const { origin } = await import("../../pithy-config");
  secureStore.items.set(BEARER_STORAGE_KEY, JSON.stringify({ token: "held-session", expiresAt: null }));
  const { adapter } = await openOn("ios");
  const read = sent.find((request) => request.url.endsWith("/get-session"));
  expect(read?.url.startsWith(`${origin}/`)).toBe(true);
  expect(read?.headers.authorization).toBe("Bearer held-session");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
  });
  await waitFor(() => expect(adapter.path()).toBe("/sign-in"));
  expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
});
