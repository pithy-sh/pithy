// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

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

const { readConsent, decideConsent, getSession, navigate } = vi.hoisted(() => ({
  readConsent: vi.fn(),
  decideConsent: vi.fn(),
  getSession: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@pithy-sh/auth/src/client/mcp", () => ({ readConsent, decideConsent }));
vi.mock("../../session", () => ({ getSession, RESUME_PARAM: "resume" }));
vi.mock("../../router", () => ({
  navigate,
  routeTable: async () => ({ byRole: new Map() }),
  screenPath: () => "/sign-in",
}));

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  readConsent.mockReset();
  navigate.mockReset();
  getSession.mockReset();
  getSession.mockResolvedValue({ user: { id: "u1" } });
  readConsent.mockResolvedValue({
    ok: true,
    value: {
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
    },
  });
});

afterEach(() => {
  host.remove();
  window.history.replaceState(null, "", "/");
});

async function rendered(): Promise<() => void> {
  const { default: Consent } = await import("./agent-consent");
  const root = createRoot(host);
  await act(async () => {
    root.render(<Consent />);
  });
  await act(async () => {});
  return () => root.unmount();
}

test("the name is reported, never the headline, and the redirect address is shown", async () => {
  // Invented values, so a screen that hard-coded a real application's name or address cannot pass by accident.
  expect(NAME_CANARY).not.toBe("");
  expect(REDIRECT_CANARY).not.toBe("");
  const unmount = await rendered();

  const heading = host.querySelector("h1")?.textContent ?? "";
  expect(heading).not.toContain(NAME_CANARY);
  // The name appears, and only in a sentence that says it was not checked.
  const mentions = [...host.querySelectorAll("*")].filter(
    (element) => element.children.length === 0 && (element.textContent ?? "").includes(NAME_CANARY),
  );
  expect(mentions.length).toBeGreaterThan(0);
  for (const element of mentions) expect(element.textContent).toMatch(/nobody has checked/i);
  // Where the access goes is on the page.
  expect(host.textContent).toContain(REDIRECT_CANARY);
  // One decision: nothing on the screen is a selection.
  expect(host.querySelectorAll("input[type=checkbox], input[type=radio], select")).toHaveLength(0);
  unmount();
});

test("what approving lets it do is shown in full: each effect, each count, and each scope it will not get", async () => {
  // The screen is the consequence of one decision, so dropping any of this hides part of what is being decided.
  const unmount = await rendered();
  const text = host.textContent ?? "";
  expect(text).toContain("changes data");
  expect(text).toContain("charges money");
  expect(text).toContain("2 of 3 operations in support.");
  expect(text).toContain("1 more needs a role you do not hold.");
  expect(text).toContain("1 of 1 operation in billing.");
  expect(text).toContain("billing_void: Requested, and not granted, because your role does not include it.");
  expect(text).toContain("everything: Requested, and not granted, because this application has no such permission.");
  expect(text).toContain("It can never do more than your role allows");
  unmount();
});

test("signed out, it sends you to sign in carrying the authorization request, unsigned, to resume", async () => {
  getSession.mockResolvedValue(null);
  const signed = "response_type=code&client_id=c1&scope=mcp&state=s1&exp=99&sig=abc&ba_iat=1&ba_param=x&ba_pl=y";
  window.history.replaceState(null, "", `/agent-consent?${signed}`);
  const unmount = await rendered();
  expect(readConsent).not.toHaveBeenCalled();
  expect(navigate).toHaveBeenCalledTimes(1);
  const target = new URL(String(navigate.mock.calls[0]?.[0]), "https://app.test");
  expect(target.pathname).toBe("/sign-in");
  const resume = target.searchParams.get("resume") ?? "";
  const { authConfig } = await import("../../pithy-config");
  expect(resume.startsWith(`${authConfig.basePath}/oauth2/authorize?`)).toBe(true);
  const params = new URL(resume, "https://app.test").searchParams;
  for (const key of ["sig", "exp", "ba_iat", "ba_param", "ba_pl"]) expect(params.has(key), key).toBe(false);
  expect(Object.fromEntries(params)).toEqual({ response_type: "code", client_id: "c1", scope: "mcp", state: "s1" });
  // And the sign-in will accept it as its resume target.
  const { resumeTarget } = await vi.importActual<typeof import("../../session")>("../../session");
  expect(resumeTarget(`?${new URLSearchParams({ resume })}`, "https://app.test")).toBe(resume);
  unmount();
});
