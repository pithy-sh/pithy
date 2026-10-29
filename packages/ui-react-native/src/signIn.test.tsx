// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BEARER_STORAGE_KEY } from "@pithy-sh/auth/src/client/bearer";
import { NEUTRAL_PROVIDER_REFUSAL } from "@pithy-sh/auth/src/http/providerRefusal";
import { KIT_CATALOGS } from "@pithy-sh/i18n/src/catalogs/kit";
import type { RouteModule } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Platform, Text } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { apple } from "../testing/expo-apple-authentication";
import { linking } from "../testing/expo-linking";
import { secureStore } from "../testing/expo-secure-store";
import { webBrowser } from "../testing/expo-web-browser";
import { google } from "../testing/google-signin";

const config = vi.hoisted(() => ({
  providers: {} as Record<string, boolean>,
  providerSignUp: undefined as Record<string, boolean> | undefined,
  signUpEnabled: true,
  webClientId: null as string | null,
  universal: null as string | null,
}));

vi.mock("../templates/src/pithy-config", async (importOriginal) => {
  const { AUTH_DISABLED } = await import("@pithy-sh/ui-core/src/config");
  return {
    ...(await importOriginal<typeof import("../templates/src/pithy-config")>()),
    // Getters, because a mock's factory runs once per file and each test sets its own projection.
    get authConfig() {
      return {
        ...AUTH_DISABLED,
        enabled: true,
        providers: config.providers,
        providerSignUp: config.providerSignUp,
        signUpEnabled: config.signUpEnabled,
      };
    },
    get googleClientIds() {
      return { webClientId: config.webClientId, iosClientId: null };
    },
    get universalLinkOrigin() {
      return config.universal;
    },
  };
});

vi.mock("../templates/src/route-modules", () => {
  const screen = (path: string, role?: string) => async () =>
    ({ path, role, default: () => <Text>{`screen ${path}`}</Text> }) as unknown as RouteModule;
  return {
    pithyRoutes: [
      screen("/sign-in", "sign-in"),
      screen("/account-suspended", "account-suspended"),
      screen("/account-deleted", "account-deleted"),
      screen("/invitations/:token"),
    ],
    appRoutes: [screen("/")],
    sessionModule: undefined,
    paymentsModule: undefined,
  };
});

const ORIGIN = "http://localhost:8787";
const AUTHORIZE = "https://github.com/login/oauth/authorize?client_id=abc&state=s";

interface Call {
  url: string;
  init: RequestInit & { headers?: Record<string, string> };
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let answers: Record<string, { status: number; body: unknown }> = {};

beforeEach(() => {
  calls = [];
  config.providers = {};
  config.providerSignUp = undefined;
  config.signUpEnabled = true;
  config.webClientId = null;
  config.universal = null;
  answers = {
    "/sign-in/social": { status: 200, body: { url: AUTHORIZE, redirect: true } },
    "/get-session": { status: 200, body: { user: { id: "u1", email: "ada@example.com" } } },
    "/handoff": { status: 200, body: { token: "traded", expiresAt: "2999-01-01T00:00:00Z" } },
  };
  vi.stubGlobal("fetch", async (url: string, init: Call["init"]) => {
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : {} });
    const route = Object.keys(answers).find((suffix) => url.endsWith(suffix));
    const { status, body } = route ? (answers[route] ?? { status: 200, body: {} }) : { status: 200, body: {} };
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
});

const os = Platform.OS;
afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

/** Open the sign-in screen at `path`, on `platform`, with the modules read after the platform is set. */
async function open(platform: "ios" | "android" | "web", path = "/sign-in", spanish = false) {
  Platform.OS = platform;
  const router = await import("../templates/src/router");
  const signIn = await import("../templates/src/routes/pithy/sign-in");
  // The provider from the same evaluation as the screen's hook, or the two are different contexts.
  const { TranslatorProvider } = await import("@pithy-sh/i18n/src/react/translator");
  const adapter = router.createMemoryAdapter(path);
  const screenNode: ReactNode = (
    <router.RouterProvider adapter={adapter}>
      <signIn.default />
    </router.RouterProvider>
  );
  await act(async () => {
    render(
      spanish ? (
        <TranslatorProvider value={{ catalogLocale: "es", formattingLocale: "es", layers: [KIT_CATALOGS.es] }}>
          {screenNode}
        </TranslatorProvider>
      ) : (
        screenNode
      ),
    );
  });
  return { adapter, signIn };
}

const posted = (suffix: string): Call | undefined => calls.find((call) => call.url.endsWith(suffix));

/** The start route the sign-in sheet was opened on, and the query it carried. */
function sheetStart(index = 0): { route: string; query: Record<string, string> } {
  const url = new URL(webBrowser.authSessions[index]?.url ?? "");
  return { route: `${url.origin}${url.pathname}`, query: Object.fromEntries(url.searchParams) };
}

const START = `${ORIGIN}/auth/sign-in/social/start`;

async function press(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.click(element);
  });
}

async function sendLinkTo(email: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: email } });
  await press(screen.getByRole("button", { name: "Email me a link" }));
}

describe("the sign-in screen", () => {
  test("sits at /sign-in and claims the role the router's guard looks up", async () => {
    const { signIn } = await open("web");
    expect(signIn.path).toBe("/sign-in");
    expect(signIn.role).toBe("sign-in");
    expect(screen.getByRole("heading").textContent).toBe("Welcome.");
  });

  test("the answer is the same whether or not the address can sign in", async () => {
    await open("web");
    await sendLinkTo("ada@example.com");
    expect(screen.getByRole("heading").textContent).toBe("Check your inbox.");
  });

  test("keeps the link shut with no address", async () => {
    await open("web");
    expect(screen.getByRole("button", { name: "Email me a link" }).getAttribute("aria-disabled")).toBe("true");
  });

  test("renders the kit's Spanish through a mounted translator", async () => {
    await open("web", "/sign-in", true);
    expect(screen.getByRole("heading").textContent).not.toBe("Welcome.");
  });
});

describe("the humanity check", () => {
  test("holds the link shut while it owes a token, and puts the token on the request once it has one", async () => {
    Platform.OS = "web";
    const router = await import("../templates/src/router");
    const { SignInScreen } = await import("../templates/src/routes/pithy/sign-in");
    const auth = { basePath: "/auth", providers: {}, signUpEnabled: true };
    const check = (pending: boolean) => ({
      widget: <Text>widget</Text>,
      pending,
      attach: (body: Record<string, unknown>) => ({ body: { ...body, "cf-turnstile-response": "tok" }, headers: {} }),
    });
    const { rerender } = render(
      <router.RouterProvider adapter={router.createMemoryAdapter("/sign-in")}>
        <SignInScreen auth={auth} check={check(true)} />
      </router.RouterProvider>,
    );
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    expect(screen.getByText("widget")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Email me a link" }).getAttribute("aria-disabled")).toBe("true");
    rerender(
      <router.RouterProvider adapter={router.createMemoryAdapter("/sign-in")}>
        <SignInScreen auth={auth} check={check(false)} />
      </router.RouterProvider>,
    );
    await press(screen.getByRole("button", { name: "Email me a link" }));
    expect(posted("/sign-in/magic-link")?.body["cf-turnstile-response"]).toBe("tok");
  });
});

describe("on the web", () => {
  test("the magic link comes back to the callback screen on this origin, carrying a resume target", async () => {
    await open("web", "/sign-in?resume=%2Fauth%2Fx");
    await sendLinkTo("ada@example.com");
    const sent = posted("/sign-in/magic-link");
    expect(sent?.url).toBe("/auth/sign-in/magic-link");
    expect(sent?.body).toEqual({ email: "ada@example.com", callbackURL: "/callback?resume=%2Fauth%2Fx" });
  });

  test("a provider leaves for its authorization page in this tab, and comes back to the same two screens", async () => {
    config.providers = { github: true };
    const { Linking } = await import("react-native");
    const leave = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    await open("web");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(posted("/sign-in/social")?.body).toEqual({
      provider: "github",
      callbackURL: "/callback",
      errorCallbackURL: "/sign-in?provider=github",
    });
    expect(leave).toHaveBeenCalledWith(AUTHORIZE, "_self");
    expect(linking.opened).toEqual([]);
    expect(webBrowser.authSessions).toEqual([]);
  });

  test("an authorization URL naming no client is refused, not followed", async () => {
    config.providers = { github: true };
    answers["/sign-in/social"] = { status: 200, body: { url: "https://github.com/login/oauth/authorize?state=s" } };
    await open("web");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(screen.getByText("GitHub is not configured here. Use the link instead.")).toBeTruthy();
    expect(linking.opened).toEqual([]);
  });

  test("a server that did not answer says something different", async () => {
    config.providers = { github: true };
    answers["/sign-in/social"] = { status: 500, body: "nope" };
    await open("web");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(screen.getByText("GitHub didn't answer. Use the link instead.")).toBeTruthy();
  });

  test("only the providers config switched on are offered, Apple and Google through the redirect", async () => {
    config.providers = { google: true, apple: true, github: false };
    await open("web");
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Apple" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue with GitHub" })).toBeNull();
    expect(screen.queryByTestId("apple-button")).toBeNull();
  });
});

describe("a refusal that came back on the link", () => {
  test("renders from the link alone, in the order that tells the reader what to do", async () => {
    config.providers = { github: true };
    await open("web", `/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`);
    expect(screen.getByText("GitHub didn't sign you in.")).toBeTruthy();
    expect(screen.getByText(/connect GitHub from your profile/)).toBeTruthy();
  });

  test("a provider nobody offers renders nothing, so the link cannot dictate product copy", async () => {
    config.providers = { github: true };
    await open("web", `/sign-in?provider=evil&error=${NEUTRAL_PROVIDER_REFUSAL}`);
    expect(screen.queryByText(/didn't sign you in/)).toBeNull();
  });

  test.each([
    ["auth%2Faccount_suspended", "/account-suspended"],
    ["auth%2Faccount_deleted", "/account-deleted"],
  ])("a refusal for the account's standing (%s) goes on to the screen for it", async (code, to) => {
    const { adapter } = await open("web", `/sign-in?error=${code}`);
    await waitFor(() => expect(adapter.path()).toBe(to));
    expect(posted("/sign-in/magic-link")).toBeUndefined();
  });
});

describe("the sign-up line", () => {
  test("keeps the plain promise where everything may sign up", async () => {
    await open("web");
    expect(screen.getByText("Signing in creates one.")).toBeTruthy();
  });

  test("scopes the promise to the link when a provider here may not create an account", async () => {
    config.providers = { github: true };
    config.providerSignUp = { github: false };
    await open("web");
    expect(screen.getByText(/The buttons above sign in existing accounts only\./)).toBeTruthy();
  });

  test("says so when sign-up is closed", async () => {
    config.signUpEnabled = false;
    await open("web");
    expect(screen.getByText("Existing accounts only.")).toBeTruthy();
  });
});

describe("on a phone with a universal link, the magic link", () => {
  test("returns to the app's https link with a challenge, and the verifier waits in the secure store", async () => {
    config.universal = "https://links.example.com";
    await open("ios", "/sign-in?resume=%2Fauth%2Fx");
    await sendLinkTo("ada@example.com");
    // The challenge is hashed and the verifier stored before the post goes out, which can outlast one act flush under load.
    await waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Check your inbox."));
    const sent = posted("/sign-in/magic-link");
    expect(sent?.url).toBe(`${ORIGIN}/auth/sign-in/magic-link`);
    expect(String(sent?.body.callbackURL)).toMatch(
      /^https:\/\/links\.example\.com\/callback\?resume=%2Fauth%2Fx&handoff_challenge=/,
    );
    expect(secureStore.items.has("pithy.auth.handoff")).toBe(true);
  });
});

describe("on a phone with no universal link, email", () => {
  test("offers no magic link: any app can claim the scheme, so the Worker would refuse one", async () => {
    await open("android");
    expect(screen.queryByRole("button", { name: "Email me a link" })).toBeNull();
    expect(screen.getByRole("button", { name: "Email me a code" })).toBeTruthy();
  });

  test("mails a one-time code and goes on to the code screen, carrying the address and the resume target", async () => {
    const { adapter } = await open("ios", "/sign-in?resume=%2Fauth%2Fx");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    await press(screen.getByRole("button", { name: "Email me a code" }));
    await waitFor(() => expect(adapter.path()).toBe("/otp?email=ada%40example.com&resume=%2Fauth%2Fx"));
    const sent = posted("/email-otp/send-verification-otp");
    expect(sent?.url).toBe(`${ORIGIN}/auth/email-otp/send-verification-otp`);
    expect(sent?.body).toMatchObject({ email: "ada@example.com", type: "sign-in" });
    expect(posted("/sign-in/magic-link")).toBeUndefined();
    expect(secureStore.items.has("pithy.auth.handoff")).toBe(false);
  });

  test("a provider that did not answer points at the code, not a link", async () => {
    config.providers = { github: true };
    webBrowser.authResult = { type: "success", url: "pithyapp://callback?code=late" };
    answers["/handoff"] = {
      status: 400,
      body: { error: { code: "auth/handoff_invalid", message: "Expired.", action: null } },
    };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(await screen.findByText("GitHub didn't answer. Use a code instead.")).toBeTruthy();
  });
});

describe("on iOS, Sign in with Apple", () => {
  test("is Apple's own button, and posts the identity token with the raw nonce whose hash Apple was given", async () => {
    config.providers = { apple: true };
    answers["/sign-in/social"] = { status: 200, body: { redirect: false, token: "apple-session", user: {} } };
    const { adapter } = await open("ios");
    expect(screen.queryByRole("button", { name: "Continue with Apple" })).toBeNull();
    await press(await screen.findByTestId("apple-button"));
    await waitFor(() => expect(adapter.path()).toBe("/"));
    const request = apple.requests[0] as { nonce?: string; requestedScopes?: number[] };
    const sent = posted("/sign-in/social");
    const idToken = sent?.body.idToken as { token: string; nonce: string };
    expect(sent?.body.provider).toBe("apple");
    expect(idToken.token).toBe("apple-identity-token");
    const hashed = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(idToken.nonce)));
    expect(request.nonce).toBe(Array.from(hashed, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    expect(request.requestedScopes?.length).toBe(2);
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("apple-session");
    expect(idToken).not.toHaveProperty("user");
  });

  test("sends the name and address Apple hands over on the first sign-in", async () => {
    config.providers = { apple: true };
    apple.next = {
      user: "apple-user",
      identityToken: "apple-identity-token",
      authorizationCode: "apple-code",
      email: "ada@example.com",
      fullName: { givenName: "Ada", familyName: null },
    };
    answers["/sign-in/social"] = { status: 200, body: { redirect: false, token: "apple-session", user: {} } };
    const { adapter } = await open("ios");
    await press(await screen.findByTestId("apple-button"));
    await waitFor(() => expect(adapter.path()).toBe("/"));
    const idToken = posted("/sign-in/social")?.body.idToken as Record<string, unknown>;
    expect(idToken.user).toEqual({ name: { firstName: "Ada" }, email: "ada@example.com" });
  });

  test("a sign-in the reader canceled says nothing and asks the Worker nothing", async () => {
    config.providers = { apple: true };
    apple.next = Object.assign(new Error("canceled"), { code: "ERR_REQUEST_CANCELED" });
    await open("ios");
    await press(await screen.findByTestId("apple-button"));
    expect(posted("/sign-in/social")).toBeUndefined();
    expect(screen.queryByText(/Apple/)).toBeNull();
  });

  test("a suspended account goes on to the suspended screen", async () => {
    config.providers = { apple: true };
    answers["/sign-in/social"] = {
      status: 403,
      body: { error: { code: "auth/account_suspended", message: "No.", action: null } },
    };
    const { adapter } = await open("ios");
    await press(await screen.findByTestId("apple-button"));
    await waitFor(() => expect(adapter.path()).toBe("/account-suspended"));
  });

  test("on Android, Apple signs in through the redirect", async () => {
    config.providers = { apple: true };
    await open("android");
    expect(screen.queryByTestId("apple-button")).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Apple" })).toBeTruthy();
  });
});

describe("on a phone, Google", () => {
  test("signs in natively, asking for an id token for the web client id, and posts it", async () => {
    config.providers = { google: true };
    config.webClientId = "web-client.apps.googleusercontent.com";
    answers["/sign-in/social"] = { status: 200, body: { redirect: false, token: "google-session", user: {} } };
    const { adapter } = await open("android");
    await press(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(adapter.path()).toBe("/"));
    expect(google.configured?.webClientId).toBe("web-client.apps.googleusercontent.com");
    expect(posted("/sign-in/social")?.body).toEqual({ provider: "google", idToken: { token: "google-id-token" } });
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("google-session");
  });

  test("an id token that never came says Google is not configured", async () => {
    config.providers = { google: true };
    config.webClientId = "web-client";
    google.next = { type: "success", data: { idToken: null, user: { id: "g", email: "a@b.c", name: null } } };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with Google" }));
    expect(screen.getByText("Google is not configured here. Use a code instead.")).toBeTruthy();
    expect(posted("/sign-in/social")).toBeUndefined();
  });

  test("a canceled sign-in says nothing", async () => {
    config.providers = { google: true };
    config.webClientId = "web-client";
    google.next = { type: "cancelled", data: null };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with Google" }));
    expect(screen.queryByText(/Google (is|didn't)/)).toBeNull();
  });

  test("with no web client id it signs in through the redirect", async () => {
    config.providers = { google: true };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with Google" }));
    expect(google.configured).toBeNull();
    expect(sheetStart().route).toBe(START);
    expect(sheetStart().query.provider).toBe("google");
  });
});

describe("on a phone, any other provider", () => {
  test("goes through the system browser and back with a one-time code, traded for the session", async () => {
    config.providers = { github: true };
    webBrowser.authResult = { type: "success", url: "pithyapp://callback?code=one-time" };
    const { adapter } = await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(adapter.path()).toBe("/"));
    // The sheet itself starts the sign-in, so the provider's state cookie lands in its jar; the app posts nothing.
    expect(posted("/sign-in/social")).toBeUndefined();
    const started = sheetStart();
    expect(started.route).toBe(START);
    expect(started.query.provider).toBe("github");
    expect(started.query.callbackURL).toMatch(/^pithyapp:\/\/callback\?handoff_challenge=/);
    expect(started.query.errorCallbackURL).toBe("pithyapp://sign-in?provider=github");
    expect(webBrowser.authSessions[0]?.redirectUrl).toBe("pithyapp://");
    expect(posted("/handoff")?.body.code).toBe("one-time");
    expect(secureStore.items.get(BEARER_STORAGE_KEY)).toContain("traded");
    expect(linking.opened).toEqual([]);
  });

  test("returns through the universal link when the app has one", async () => {
    config.providers = { github: true };
    config.universal = "https://links.example.com";
    webBrowser.authResult = { type: "success", url: "https://links.example.com/callback?code=one-time" };
    const { adapter } = await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(adapter.path()).toBe("/"));
    expect(posted("/sign-in/social")).toBeUndefined();
    const started = sheetStart();
    expect(started.route).toBe(START);
    expect(started.query.callbackURL).toMatch(/^https:\/\/links\.example\.com\/callback\?handoff_challenge=/);
    expect(started.query.errorCallbackURL).toBe("https://links.example.com/callback?provider=github");
    expect(webBrowser.authSessions[0]?.redirectUrl).toBe("https://links.example.com/callback");
    expect(posted("/handoff")?.body.code).toBe("one-time");
  });

  test("a refusal that came back through the universal link still renders here", async () => {
    config.providers = { github: true };
    config.universal = "https://links.example.com";
    webBrowser.authResult = {
      type: "success",
      url: `https://links.example.com/callback?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`,
    };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(await screen.findByText("GitHub didn't sign you in.")).toBeTruthy();
  });

  test("an invitation that sent somebody to sign in is where the app goes after, not a browser", async () => {
    config.providers = { github: true };
    webBrowser.authResult = { type: "success", url: "pithyapp://callback?resume=%2Finvitations%2Ftok_1&code=one-time" };
    const { adapter } = await open("ios", "/sign-in?resume=%2Finvitations%2Ftok_1");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(adapter.path()).toBe("/invitations/tok_1"));
    expect(webBrowser.opened).toEqual([]);
  });

  test("a refusal the provider sent back renders on this screen, from the link", async () => {
    config.providers = { github: true };
    webBrowser.authResult = {
      type: "success",
      url: `pithyapp://sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`,
    };
    const { adapter } = await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    await waitFor(() => expect(adapter.path()).toBe(`/sign-in?provider=github&error=${NEUTRAL_PROVIDER_REFUSAL}`));
    expect(await screen.findByText("GitHub didn't sign you in.")).toBeTruthy();
    expect(secureStore.items.has("pithy.auth.handoff")).toBe(false);
  });

  test("closing the browser forgets the verifier and says nothing", async () => {
    config.providers = { github: true };
    webBrowser.authResult = { type: "cancel" };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(secureStore.items.has("pithy.auth.handoff")).toBe(false);
    expect(posted("/handoff")).toBeUndefined();
    expect(screen.queryByText(/GitHub (is|didn't)/)).toBeNull();
  });

  test("a trade the Worker refused says the provider did not answer", async () => {
    config.providers = { github: true };
    answers["/handoff"] = {
      status: 400,
      body: { error: { code: "auth/handoff_invalid", message: "Expired.", action: null } },
    };
    config.universal = "https://links.example.com";
    webBrowser.authResult = { type: "success", url: "https://links.example.com/callback?code=late" };
    await open("ios");
    await press(screen.getByRole("button", { name: "Continue with GitHub" }));
    expect(await screen.findByText("GitHub didn't answer. Use the link instead.")).toBeTruthy();
    expect(secureStore.items.has(BEARER_STORAGE_KEY)).toBe(false);
  });
});
