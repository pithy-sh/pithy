// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { ConsentFetch, ConsentRequestInit } from "@pithy-sh/consent/src/client/api";
import type { ScreenRole } from "@pithy-sh/ui-core/src/routes";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConsentScreen, role } from "../templates/src/routes/pithy/consent";

/**
 * The scaffolded consent settings screen, rendered against a stand-in Worker and asked what it does.
 *
 * What only a render can show: a purpose a click grants is withdrawn by a click on the same row — withdrawing is
 * never harder than granting — and a purpose that requires a written withdrawal asks for it at the grade of the
 * grant behind it: a typed name for a typed grant, a drawn signature for a drawn one, and for a grant signed through
 * a provider, the place it was signed. The server refuses a withdrawal below its grant, so the screen never offers
 * one that cannot succeed.
 */

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

let mounted: { container: HTMLElement; unmount: () => void } | null = null;

async function mount(node: ReactNode): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
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

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** The row holding a purpose's summary. */
function row(container: HTMLElement, id: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".stack")].find((el) =>
    el.textContent?.includes(`${id} summary`),
  );
  if (!found) throw new Error(`no row for ${id}`);
  return found;
}

async function click(button: HTMLButtonElement | null | undefined): Promise<void> {
  await act(async () => {
    button?.click();
  });
}

describe("the consent settings screen", () => {
  test("agreeing and withdrawing a click purpose are one click each, on the same row", async () => {
    const { fetcher, writes } = worker();
    const container = await mount(<ConsentScreen client={{ fetch: fetcher }} />);

    await click(row(container, "email.marketing").querySelector("button"));
    await click(row(container, "email.tracking").querySelector("button"));
    expect(writes).toEqual([
      {
        url: "/consent/grants",
        body: { purpose: "email.marketing", noticeVersion: 1, method: "click", surface: "settings" },
      },
      { url: "/consent/withdrawals", body: { purpose: "email.tracking", method: "click", surface: "settings" } },
    ]);
  });

  test("a written withdrawal asks for the typed name behind a signed grant, and sends it", async () => {
    const { fetcher, writes } = worker();
    const container = await mount(<ConsentScreen client={{ fetch: fetcher }} />);
    const signed = row(container, "clinic.records");
    const input = signed.querySelector("input");
    const button = signed.querySelector("button");
    expect(input).not.toBeNull();
    expect(button?.disabled).toBe(true);

    await act(async () => {
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Ada Lovelace");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(row(container, "clinic.records").querySelector("button"));
    expect(writes).toEqual([
      {
        url: "/consent/withdrawals",
        body: { purpose: "clinic.records", method: "typed", surface: "settings", typedName: "Ada Lovelace" },
      },
    ]);
  });

  test("a drawn grant is withdrawn by drawing, never by a typed name the server would refuse", async () => {
    const png = "iVBORw0KGgo=";
    const context = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), clearRect: vi.fn() };
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
    const toDataURL = vi
      .spyOn(HTMLCanvasElement.prototype, "toDataURL")
      .mockReturnValue(`data:image/png;base64,${png}`);
    try {
      const { fetcher, writes } = worker(SIGNED);
      const container = await mount(<ConsentScreen client={{ fetch: fetcher }} />);
      const hipaa = row(container, "clinic.hipaa");
      expect(hipaa.querySelector("input")).toBeNull();
      const canvas = hipaa.querySelector("canvas");
      expect(canvas).not.toBeNull();
      const withdraw = () =>
        [...row(container, "clinic.hipaa").querySelectorAll("button")].find((b) => b.textContent === "Withdraw");
      expect(withdraw()?.disabled).toBe(true);

      await act(async () => {
        for (const type of ["pointerdown", "pointermove", "pointerup"]) {
          canvas?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10 }));
        }
      });
      expect(withdraw()?.disabled).toBe(false);
      await click(withdraw());
      expect(writes).toEqual([
        {
          url: "/consent/withdrawals",
          body: {
            purpose: "clinic.hipaa",
            method: "drawn",
            surface: "settings",
            drawn: { image: png, type: "image/png" },
          },
        },
      ]);
    } finally {
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });

  test("a grant signed through a provider says where to withdraw it, and offers nothing that cannot succeed", async () => {
    const { fetcher, writes } = worker(SIGNED);
    const container = await mount(<ConsentScreen client={{ fetch: fetcher }} />);
    const trial = row(container, "clinic.trial");
    expect(trial.querySelector("button")).toBeNull();
    expect(trial.querySelector("input")).toBeNull();
    expect(trial.textContent).toContain("Withdraw it where you signed it.");
    expect(writes).toEqual([]);
  });
});

describe("the consent screen's role", () => {
  test("is one the router knows, so a privacy link finds the screen by its job", () => {
    const claimed: ScreenRole = role;
    expect(claimed).toBe("consent");
  });
});
