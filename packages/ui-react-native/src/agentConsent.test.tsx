// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Platform } from "react-native";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { linking } from "../testing/expo-linking";

/**
 * **The consent screen never presents an application's name as a fact, and always shows where access goes.**
 *
 * Anybody can register an application and call it anything, so the name on this screen is whatever the
 * application said. The thing that identifies it is the redirect address, which the authorization server enforces.
 * A restyle that makes the name the headline — or that drops the address as clutter — looks like an improvement and
 * turns the screen into a phishing page on your domain. Nobody notices in a manual test, because the application
 * you test with is your own.
 *
 * So the assertions are: the name appears only inside the sentence that says nobody checked it, it is never the
 * heading, and the redirect address is on the page.
 */

const NAME_CANARY = "Canary Official Sync";
const REDIRECT_CANARY = "http://127.0.0.1:4317/canary-callback";
const ORIGIN = "http://localhost:8787";

const { readConsent, decideConsent, getSession } = vi.hoisted(() => ({
  readConsent: vi.fn(),
  decideConsent: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock("@pithy-sh/auth/src/client/mcp", () => ({ readConsent, decideConsent }));
vi.mock("../templates/src/session", () => ({ getSession, RESUME_PARAM: "resume" }));
vi.mock("../templates/src/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/router")>()),
  routeTable: async () => ({ byRole: new Map() }),
}));
vi.mock("@pithy-sh/ui-core/src/routes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/ui-core/src/routes")>()),
  screenPath: () => "/sign-in",
}));

const VIEW = {
  client: { id: "c1", reportedName: NAME_CANARY, reportedUri: null, redirectUri: REDIRECT_CANARY },
  capabilities: [
    {
      capability: "support",
      operations: [
        { tool: "support_feedback_list", summary: "List your requests.", effect: null },
        { tool: "support_feedback_reply", summary: "Reply to a request.", effect: "writes" },
      ],
      reachable: 2,
      total: 3,
      effects: { writes: 1, sends: 0, charges: 0, deletes: 0 },
    },
    {
      capability: "billing",
      operations: [{ tool: "billing_refund", summary: "Refund a charge.", effect: "charges" }],
      reachable: 1,
      total: 1,
      effects: { writes: 0, sends: 0, charges: 1, deletes: 0 },
    },
  ],
  requested: [
    { scope: "mcp", granted: true, reason: null },
    { scope: "billing_void", granted: false, reason: "role" },
    { scope: "everything", granted: false, reason: "unknown" },
  ],
};

const os = Platform.OS;

beforeEach(() => {
  readConsent.mockReset();
  decideConsent.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  readConsent.mockResolvedValue({ ok: true, value: VIEW });
});

afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.resetModules();
});

async function rendered(at = "/agent-consent?client_id=c1&state=s1", platform: "ios" | "web" = "web") {
  Platform.OS = platform;
  const { default: Consent } = await import("../templates/src/routes/pithy/agent-consent");
  const { createMemoryAdapter, RouterProvider, usePath } = await import("../templates/src/router");
  // The screen while the app is at its path, as the router mounts it: leaving unmounts it.
  function Mounted() {
    return usePath() === "/agent-consent" ? <Consent /> : null;
  }
  const adapter = createMemoryAdapter(at);
  const view = render(
    <RouterProvider adapter={adapter}>
      <Mounted />
    </RouterProvider>,
  );
  return { adapter, view };
}

describe("the agent consent screen", () => {
  test("the name is reported, never the headline, and the redirect address is shown", async () => {
    // Invented values, so a screen that hard-coded a real application's name or address cannot pass by accident.
    expect(NAME_CANARY).not.toBe("");
    expect(REDIRECT_CANARY).not.toBe("");
    const { view } = await rendered();
    await screen.findByText(REDIRECT_CANARY);

    const heading = view.container.querySelector("h1")?.textContent ?? "";
    expect(heading).toBe("An application wants to act as you.");
    expect(heading).not.toContain(NAME_CANARY);
    // The name appears, and only in a sentence that says it was not checked.
    const mentions = [...view.container.querySelectorAll("*")].filter(
      (element) => element.children.length === 0 && (element.textContent ?? "").includes(NAME_CANARY),
    );
    expect(mentions.length).toBeGreaterThan(0);
    for (const element of mentions) expect(element.textContent).toMatch(/nobody has checked/i);
    // Where the access goes is on the page.
    expect(view.container.textContent).toContain(REDIRECT_CANARY);
    // One decision: nothing on the screen is a selection.
    expect(view.container.querySelectorAll("input, select, [role=checkbox], [role=radio], [role=switch]")).toHaveLength(
      0,
    );
    expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "Let it act as me",
      "Don't allow",
    ]);
  });

  test("what approving lets it do is shown in full: each effect, each count, and each scope it will not get", async () => {
    // The screen is the consequence of one decision, so dropping any of this hides part of what is being decided.
    const { view } = await rendered();
    await screen.findByText(REDIRECT_CANARY);
    const text = view.container.textContent ?? "";
    expect(text).toContain("changes data");
    expect(text).toContain("charges money");
    expect(text).toContain("2 of 3 operations in support.");
    expect(text).toContain("1 more needs a role you do not hold.");
    expect(text).toContain("1 of 1 operation in billing.");
    expect(text).toContain("billing_void: Requested, and not granted, because your role does not include it.");
    expect(text).toContain("everything: Requested, and not granted, because this application has no such permission.");
    expect(text).toContain("It can never do more than your role allows");
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });

  test("it reads the request it was opened with, from the router's query", async () => {
    await rendered();
    await screen.findByText(REDIRECT_CANARY);
    expect(readConsent).toHaveBeenCalledWith("client_id=c1&state=s1", { basePath: "/mcp" });
  });

  test("signed out, it sends you to sign in carrying the authorization request, unsigned, to resume", async () => {
    getSession.mockResolvedValue(null);
    const signed = "response_type=code&client_id=c1&scope=mcp&state=s1&exp=99&sig=abc&ba_iat=1&ba_param=x&ba_pl=y";
    const { adapter } = await rendered(`/agent-consent?${signed}`);
    await waitFor(() => expect(adapter.history).toHaveLength(2));
    expect(readConsent).not.toHaveBeenCalled();
    const target = String(adapter.history[1]);
    const { parseQuery } = await import("../templates/src/platform");
    expect(target.split("?")[0]).toBe("/sign-in");
    const resume = parseQuery(target.slice(target.indexOf("?"))).resume ?? "";
    const { authConfig } = await import("../templates/src/pithy-config");
    expect(resume.startsWith(`${authConfig.basePath}/oauth2/authorize?`)).toBe(true);
    const params = parseQuery(resume.slice(resume.indexOf("?")));
    for (const key of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) expect(key in params, key).toBe(false);
    expect(params).toEqual({ response_type: "code", client_id: "c1", scope: "mcp", state: "s1" });
    // And the sign-in will accept it as its resume target.
    const { resumeTarget } =
      await vi.importActual<typeof import("../templates/src/session")>("../templates/src/session");
    expect(resumeTarget(target.slice(target.indexOf("?")))).toBe(resume);
  });

  test("on the web, a decision loads the application's own address in this tab, never a new one", async () => {
    // `expo-linking` hands React Native Web one argument, and one argument means `_blank`: a new tab opened after
    // an await, which a popup blocker stops, leaving this tab on a decided request.
    const { Linking } = await import("react-native");
    const open = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    decideConsent.mockResolvedValue({ ok: true, value: { redirect: `${REDIRECT_CANARY}?code=k1&state=s1` } });
    await rendered();
    fireEvent.click(await screen.findByRole("button", { name: "Let it act as me" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(`${REDIRECT_CANARY}?code=k1&state=s1`, "_self"));
    expect(decideConsent).toHaveBeenCalledWith("client_id=c1&state=s1", true, { basePath: "/mcp" });
    expect(linking.opened).toEqual([]);
    open.mockRestore();
  });

  test("on the web, leaving goes through React Native Web's own Linking, which resolves", async () => {
    // No stand-in for `openURL` here: React Native Web's reads its own state, so a copy of the method taken off the
    // object rejects after the page has already been told to leave.
    const { Linking } = await import("react-native");
    const open = vi.fn();
    vi.stubGlobal("open", open);
    // React Native Web's `Linking` announces a link it opened only after the open, and only on a call made on it.
    const announcer = Linking as unknown as { addEventListener(event: string, listener: (url: string) => void): void };
    const announced: string[] = [];
    announcer.addEventListener("onOpen", (url) => announced.push(url));
    const target = `${REDIRECT_CANARY}?code=k1&state=s1`;
    decideConsent.mockResolvedValue({ ok: true, value: { redirect: target } });
    await rendered();
    fireEvent.click(await screen.findByRole("button", { name: "Let it act as me" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(target, "_self", "noopener"));
    await waitFor(() => expect(announced).toContain(target));
    vi.unstubAllGlobals();
  });

  test("on a phone, a decision hands the application's own address to the system", async () => {
    decideConsent.mockResolvedValue({ ok: true, value: { redirect: `${REDIRECT_CANARY}?code=k1&state=s1` } });
    await rendered("/agent-consent?client_id=c1&state=s1", "ios");
    fireEvent.click(await screen.findByRole("button", { name: "Let it act as me" }));
    await waitFor(() => expect(linking.opened).toEqual([`${REDIRECT_CANARY}?code=k1&state=s1`]));
  });

  test("a refused decision says the request expired, and leaves for nowhere", async () => {
    decideConsent.mockResolvedValue({ ok: false, failure: { code: "auth/expired", message: "Expired." } });
    await rendered();
    fireEvent.click(await screen.findByRole("button", { name: "Don't allow" }));
    await screen.findByText("This request has expired. Start again from the application.");
    expect(decideConsent).toHaveBeenCalledWith("client_id=c1&state=s1", false, { basePath: "/mcp" });
    expect(linking.opened).toEqual([]);
  });

  test("a request that cannot be read says it expired", async () => {
    readConsent.mockResolvedValue({ ok: false, failure: { code: "auth/expired", message: "Expired." } });
    await rendered();
    await screen.findByText("This request has expired. Start again from the application.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  test("on a phone, the request goes to the Worker's origin with the bearer session's fetch", async () => {
    await rendered("/agent-consent?client_id=c1&state=s1", "ios");
    await screen.findByText(REDIRECT_CANARY);
    const options = readConsent.mock.calls[0]?.[1];
    expect(options).toMatchObject({ origin: ORIGIN, basePath: "/mcp" });
    expect(typeof options?.fetch).toBe("function");
  });
});
