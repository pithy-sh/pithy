// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CONSENT_VISITOR_HEADER, type ConsentFetch, type ConsentRequestInit } from "@pithy-sh/consent/src/client/api";
import type { ScreenRole } from "@pithy-sh/ui-core/src/routes";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { afterEach, describe, expect, test, vi } from "vitest";

/**
 * The scaffolded consent settings screen, rendered against a stand-in Worker and asked what it does.
 *
 * What only a render can show: a purpose a click grants is withdrawn by a click on the same row — withdrawing is
 * never harder than granting — and a purpose that requires a written withdrawal asks for it at the grade of the
 * grant behind it: a typed name for a typed grant, a drawn signature for a drawn one, and for a grant signed through
 * a provider, the place it was signed. The server refuses a withdrawal below its grant, so the screen never offers
 * one that cannot succeed.
 */

const ORIGIN = "http://localhost:8787";

const purpose = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  summary: `${id} summary`,
  noticeVersion: 1,
  classes: [],
  explicit: false,
  minimumMethod: "click",
  writtenWithdrawal: false,
  ...over,
});

const record = (purposeId: string, method: string) => ({
  id: `r-${purposeId}`,
  subject: { kind: "account", id: "ada" },
  purpose: purposeId,
  action: "grant",
  noticeVersion: 1,
  method,
  surface: "intake",
  identity: "session",
  documentHash: null,
  typedName: null,
  drawnImageHash: null,
  drawnImageType: null,
  provider: null,
  providerEnvelopeId: null,
  providerCertificateHash: null,
  expiresAt: null,
  representative: null,
  recordedAt: "2026-10-27T12:00:00.000Z",
});

const written = (id: string, minimumMethod: string) => ({
  purpose: purpose(id, { minimumMethod, writtenWithdrawal: true }),
  standing: "granted",
  granted: true,
});

const ME = {
  subject: { kind: "account", id: "ada" },
  purposes: [
    { purpose: purpose("email.marketing"), standing: "never_granted", granted: false },
    { purpose: purpose("email.tracking"), standing: "granted", granted: true },
    {
      purpose: purpose("clinic.records", { minimumMethod: "typed", writtenWithdrawal: true }),
      standing: "granted",
      granted: true,
    },
  ],
  records: [record("email.tracking", "click"), record("clinic.records", "typed")],
};

/** A reader holding one drawn and one provider-signed grant, each requiring a written withdrawal. */
const SIGNED = {
  subject: { kind: "account", id: "ada" },
  purposes: [written("clinic.hipaa", "drawn"), written("clinic.trial", "provider")],
  records: [record("clinic.hipaa", "drawn"), { ...record("clinic.trial", "provider"), provider: "docusign" }],
};

/** A stand-in Worker: `/me` answers {@link ME}, and every write is recorded and accepted. */
function worker(me: unknown = ME) {
  const writes: { url: string; body: unknown }[] = [];
  const fetcher: ConsentFetch = async (url: string, init?: ConsentRequestInit) => {
    if (init?.method === "POST") {
      writes.push({ url, body: JSON.parse(init.body ?? "{}") });
      return {
        ok: true,
        status: 201,
        json: async () => ({ record: record("x", "click"), standing: "granted", granted: true }),
      };
    }
    return { ok: true, status: 200, json: async () => me };
  };
  return { fetcher, writes };
}

const os = Platform.OS;

afterEach(() => {
  cleanup();
  Platform.OS = os;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount(node: (screen: typeof import("../templates/src/routes/pithy/consent")) => ReactNode) {
  const module = await import("../templates/src/routes/pithy/consent");
  await act(async () => {
    render(node(module));
  });
}

/** The row holding a purpose. */
function row(id: string): HTMLElement {
  return screen.getByTestId(`consent-${id}`);
}

function buttonIn(element: HTMLElement, name: string): HTMLElement | undefined {
  return [...element.querySelectorAll<HTMLElement>("[role=button]")].find((button) => button.textContent === name);
}

async function press(button: HTMLElement | undefined): Promise<void> {
  if (!button) throw new Error("no such button");
  await act(async () => {
    fireEvent.click(button);
  });
}

describe("the consent settings screen", () => {
  test("agreeing and withdrawing a click purpose are one press each, on the same row", async () => {
    const { fetcher, writes } = worker();
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    expect((await screen.findByRole("heading")).textContent).toBe("Your privacy choices.");

    await press(buttonIn(row("email.marketing"), "Agree"));
    await press(buttonIn(row("email.tracking"), "Withdraw"));
    expect(writes).toEqual([
      {
        url: "/consent/grants",
        body: { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "settings" },
      },
      { url: "/consent/withdrawals", body: { purpose: "email.tracking", method: "click", surface: "settings" } },
    ]);
    await screen.findByText("Saved.");
  });

  test("a written withdrawal asks for the typed name behind a signed grant, and sends it", async () => {
    const { fetcher, writes } = worker();
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    const input = await screen.findByLabelText("Type your full name to withdraw in writing");
    expect(row("clinic.records").contains(input)).toBe(true);
    expect(buttonIn(row("clinic.records"), "Withdraw")?.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      fireEvent.change(input, { target: { value: "Ada Lovelace" } });
    });
    expect(buttonIn(row("clinic.records"), "Withdraw")?.getAttribute("aria-disabled")).not.toBe("true");
    await press(buttonIn(row("clinic.records"), "Withdraw"));
    expect(writes).toEqual([
      {
        url: "/consent/withdrawals",
        body: { purpose: "clinic.records", method: "typed", surface: "settings", typedName: "Ada Lovelace" },
      },
    ]);
  });

  test("a drawn grant is withdrawn by drawing, never by a typed name the server would refuse", async () => {
    const { fetcher, writes } = worker(SIGNED);
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    const pad = await screen.findByLabelText("Sign below to withdraw in writing");
    const hipaa = row("clinic.hipaa");
    expect(hipaa.contains(pad)).toBe(true);
    expect(hipaa.querySelector("input")).toBeNull();
    const withdraw = () => buttonIn(row("clinic.hipaa"), "Withdraw");
    expect(withdraw()?.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      fireEvent.mouseDown(pad, { clientX: 10, clientY: 10, button: 0, buttons: 1 });
      fireEvent.mouseMove(pad, { clientX: 40, clientY: 30, button: 0, buttons: 1 });
      fireEvent.mouseUp(pad, { clientX: 40, clientY: 30, button: 0 });
    });
    expect(withdraw()?.getAttribute("aria-disabled")).not.toBe("true");
    await press(withdraw());
    expect(writes).toHaveLength(1);
    const body = writes[0]?.body as { drawn: { image: string; type: string } };
    expect(writes[0]?.url).toBe("/consent/withdrawals");
    expect(body).toMatchObject({ purpose: "clinic.hipaa", method: "drawn", surface: "settings" });
    expect(body.drawn.type).toBe("image/svg+xml");
    // What the server stores is the drawing itself: an SVG of the stroke that was drawn, as standard base64.
    const svg = atob(body.drawn.image);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('d="M10 10 L40 30"');
  });

  test("clearing a drawing takes the withdrawal back to waiting for one", async () => {
    const { fetcher } = worker(SIGNED);
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    const pad = await screen.findByLabelText("Sign below to withdraw in writing");
    await act(async () => {
      fireEvent.mouseDown(pad, { clientX: 5, clientY: 5, button: 0, buttons: 1 });
      fireEvent.mouseUp(pad, { clientX: 5, clientY: 5, button: 0 });
    });
    expect(buttonIn(row("clinic.hipaa"), "Withdraw")?.getAttribute("aria-disabled")).not.toBe("true");
    await press(buttonIn(row("clinic.hipaa"), "Clear"));
    expect(buttonIn(row("clinic.hipaa"), "Withdraw")?.getAttribute("aria-disabled")).toBe("true");
  });

  test("a grant signed through a provider says where to withdraw it, and offers nothing that cannot succeed", async () => {
    const { fetcher, writes } = worker(SIGNED);
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    await screen.findByText("You signed this through an e-signature service. Withdraw it where you signed it.");
    const trial = row("clinic.trial");
    expect(trial.querySelector("[role=button]")).toBeNull();
    expect(trial.querySelector("input")).toBeNull();
    expect(writes).toEqual([]);
  });

  test("a refusal reads in the reader's language where a catalog has the code, and in the server's English where none does", async () => {
    const fetcher: ConsentFetch = async () => ({
      ok: false,
      status: 403,
      json: async () => ({ error: { code: "consent/somewhere_else", message: "Not for you." } }),
    });
    await mount(({ ConsentScreen }) => <ConsentScreen client={{ fetch: fetcher }} />);
    expect((await screen.findByRole("heading")).textContent).toBe("We couldn't load your choices.");
    expect(screen.getByText("Not for you.")).toBeTruthy();
  });
});

describe("the consent screen's transport", () => {
  test("on the web, it reads the page's own origin with the cookie", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
    });
    Platform.OS = "web";
    await mount(({ default: Consent }) => <Consent />);
    await screen.findByText("email.marketing summary");
    expect(calls[0]?.url).toBe("/consent/me");
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });

  test("on a phone, it reads the Worker's origin with the bearer session's fetch and no cookie", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
    });
    Platform.OS = "ios";
    await mount(({ default: Consent }) => <Consent />);
    await waitFor(() => expect(calls.some((call) => call.url === `${ORIGIN}/consent/me`)).toBe(true));
    const read = calls.find((call) => call.url === `${ORIGIN}/consent/me`);
    expect(read?.init.credentials).toBe("omit");
  });
});

describe("the consent screen at a custom base path", () => {
  /** The generated config of a Worker composing `consent({ basePath: "/privacy" })`. */
  async function composedAtPrivacy(): Promise<void> {
    const template = (await import("../templates/src/pithy-config.generated")).default;
    const privacy = { enabled: true, basePath: "/privacy" };
    vi.doMock("../templates/src/pithy-config.generated", () => ({
      default: { ...template, consent: { dev: privacy, staging: privacy, prod: privacy } },
    }));
  }

  afterEach(() => {
    vi.doUnmock("../templates/src/pithy-config.generated");
  });

  test("on the web, it calls the configured base path", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
    });
    Platform.OS = "web";
    await composedAtPrivacy();
    await mount(({ default: Consent }) => <Consent />);
    await screen.findByText("email.marketing summary");
    expect(calls[0]).toBe("/privacy/me");
  });

  test("on a phone, it calls the configured base path, carrying the visitor id consent knows it by", async () => {
    const calls: { url: string; init: RequestInit & { headers?: Record<string, string> } }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit & { headers?: Record<string, string> }) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(ME), { status: 200, headers: { "content-type": "application/json" } });
    });
    Platform.OS = "ios";
    await composedAtPrivacy();
    await mount(({ default: Consent }) => <Consent />);
    await waitFor(() => expect(calls.some((call) => call.url === `${ORIGIN}/privacy/me`)).toBe(true));
    const read = calls.find((call) => call.url === `${ORIGIN}/privacy/me`);
    expect(read?.init.headers?.[CONSENT_VISITOR_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.some((call) => call.url.startsWith(`${ORIGIN}/consent/`))).toBe(false);
  });
});

describe("the consent screen's role", () => {
  test("is one the router knows, so a privacy link finds the screen by its job", async () => {
    const { role } = await import("../templates/src/routes/pithy/consent");
    const claimed: ScreenRole = role;
    expect(claimed).toBe("consent");
  });
});
