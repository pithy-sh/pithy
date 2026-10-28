// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * **A sign-in the consent screen sent somebody to picks up the authorization request it stopped at.** The consent
 * screen hands a signed-out user to sign-in with `?resume=<the authorization request>`; the magic-link and social
 * callback, and the one-time code screen, follow it with a document load once the session exists, and go home when
 * there is nothing on this origin to resume. `resume.test.tsx` holds how the target is read; this holds that the
 * screens act on it.
 */

const navigate = vi.fn((_path: string) => {});
const session = { current: null as { user: { id: string } } | null };
const signInWithOtp = vi.fn(async () => ({ ok: true as const, value: null }));

vi.mock("../templates/src/pithy-config", () => ({
  authConfig: {
    enabled: true,
    basePath: "/auth",
    providers: { google: false, apple: false, facebook: false, github: false, microsoft: false },
    otpLength: 1,
    signUpEnabled: true,
  },
  turnstileConfig: {
    enabled: false,
    sitekey: "",
    action: "",
    mode: "visible" as const,
    token: { field: "cf-turnstile-response", header: null },
  },
}));

vi.mock("../templates/src/router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/router")>()),
  navigate: (path: string) => navigate(path),
  routeTable: async () => ({}),
  screenPath: (_table: unknown, role: string) => `/${role}`,
}));

vi.mock("../templates/src/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../templates/src/session")>()),
  getSession: async () => session.current,
}));

vi.mock("@pithy-sh/auth/src/client/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pithy-sh/auth/src/client/api")>()),
  signInWithOtp: () => signInWithOtp(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The authorization request the consent screen stopped at. */
const AUTHORIZE = "/auth/oauth2/authorize?client_id=c1&state=s1";

let assign: ReturnType<typeof vi.fn>;
let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function render(node: ReactNode): Promise<HTMLElement> {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  mounted = {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
  return container;
}

/** Land on `path` with `resume` in the query, or with none. */
function landOn(path: string, resume?: string): void {
  window.history.replaceState({}, "", resume === undefined ? path : `${path}?${new URLSearchParams({ resume })}`);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  assign = vi.fn();
  vi.spyOn(window.location, "assign").mockImplementation(assign as unknown as (url: string | URL) => void);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  navigate.mockClear();
  signInWithOtp.mockClear();
  session.current = null;
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("resumeAfterSignIn", () => {
  test("loads the resume target and says the browser is leaving", async () => {
    const { resumeAfterSignIn } = await import("../templates/src/session");
    landOn("/callback", AUTHORIZE);
    expect(resumeAfterSignIn()).toBe(true);
    expect(assign).toHaveBeenCalledWith(AUTHORIZE);
  });

  test("does nothing with no target, or one off this origin", async () => {
    const { resumeAfterSignIn } = await import("../templates/src/session");
    for (const resume of [undefined, "https://evil.test/x", "//evil.test/x"]) {
      landOn("/callback", resume);
      expect(resumeAfterSignIn(), String(resume)).toBe(false);
    }
    expect(assign).not.toHaveBeenCalled();
  });
});

describe("the callback screen", () => {
  test("a signed-in landing carrying a resume target goes on to it, not home", async () => {
    const { default: Callback } = await import("../templates/src/routes/pithy/callback");
    session.current = { user: { id: "u1" } };
    landOn("/callback", AUTHORIZE);
    await render(<Callback />);
    await settle();
    expect(assign).toHaveBeenCalledWith(AUTHORIZE);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a resume target off this origin is dropped, and the landing goes home", async () => {
    const { default: Callback } = await import("../templates/src/routes/pithy/callback");
    session.current = { user: { id: "u1" } };
    landOn("/callback", "https://evil.test/auth/oauth2/authorize");
    await render(<Callback />);
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });

  test("a landing with no session resumes nothing, and goes back to sign in", async () => {
    const { default: Callback } = await import("../templates/src/routes/pithy/callback");
    landOn("/callback", AUTHORIZE);
    await render(<Callback />);
    await settle();
    expect(assign).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/sign-in");
  });
});

describe("the one-time code screen", () => {
  async function verifyCode(): Promise<void> {
    const { default: Otp } = await import("../templates/src/routes/pithy/otp");
    const container = await render(<Otp />);
    const input = container.querySelector("input");
    await act(async () => {
      if (input === null) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(input, "7");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = container.querySelector("button");
    await act(async () => {
      submit?.click();
    });
    await settle();
    expect(signInWithOtp).toHaveBeenCalledTimes(1);
  }

  test("a right code resumes the authorization request the sign-in was sent from", async () => {
    landOn("/otp", AUTHORIZE);
    await verifyCode();
    expect(assign).toHaveBeenCalledWith(AUTHORIZE);
    expect(navigate).not.toHaveBeenCalled();
  });

  test("a right code with nothing to resume goes home", async () => {
    landOn("/otp");
    await verifyCode();
    expect(assign).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/");
  });
});
