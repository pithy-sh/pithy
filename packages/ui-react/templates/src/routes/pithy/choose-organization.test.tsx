// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * **Choosing an account leaves by a document load, and a single membership is entered without asking.**
 *
 * Two behaviours, and neither is visible to anybody already inside an account — which is why this test
 * is seeded into your repository rather than kept in the kit.
 *
 * ## Why the navigation kind matters, and why nothing you click will show you
 *
 * What is in force decides what every subsequent request may reach. An in-app route change keeps the
 * React tree alive, so whatever the previous account's data had already populated — a roster, a header,
 * a cached list, a query result held in a provider — survives the switch and is now being shown to
 * somebody acting as a different tenant. The session underneath is correct; the page is a fortnight of
 * the wrong company's data.
 *
 * `navigate()` from `../../router` and `window.location.assign()` are one character apart in intent and
 * look identical in every manual test, because the first account you try it with is the one whose data
 * is already on screen. The first time it is visibly wrong is a customer with two accounts, in
 * production, looking at the other one's members.
 *
 * ## Why the single membership still writes
 *
 * Somebody who belongs to exactly one account is not choosing. Rendering a one-item list asks them to
 * confirm a decision that was never theirs. But redirecting *without* recording it leaves `acting` null,
 * so every later request resolves the same membership again — and `chosen` is what tells a switcher
 * that nobody picked this, which a single `activeOrganizationId` column cannot carry.
 *
 * So: enter it, and write it. The assertion below is that the write happened, not only the redirect.
 */

const ONLY = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Games",
  slug: "acme",
  mark: null,
  role: "admin",
  createdAt: "2026-09-01T12:00:00.000Z",
};
const OTHER = { ...ONLY, id: "22222222-2222-4222-8222-222222222222", name: "Beta Studio", slug: "beta" };

const listOrganizations = vi.fn();
const chooseOrganization = vi.fn();

vi.mock("@pithy-sh/organization/src/index", () => ({ listOrganizations, chooseOrganization }));

let host: HTMLElement;
let assign: ReturnType<typeof vi.fn>;
let pushState: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  assign = vi.fn();
  Object.defineProperty(window, "location", { value: { ...window.location, assign }, writable: true });
  pushState = vi.spyOn(window.history, "pushState");
  listOrganizations.mockReset();
  chooseOrganization.mockReset();
});

afterEach(() => {
  host.remove();
  pushState.mockRestore();
  vi.resetModules();
});

/** Render the screen and let its effects settle. */
async function render(): Promise<void> {
  const { default: ChooseOrganization } = await import("./choose-organization");
  await act(async () => {
    createRoot(host).render(<ChooseOrganization />);
  });
}

test("a single membership is entered without asking, and the choice is still written", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [ONLY], acting: null, chosen: false } });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ONLY.id, chosen: true } });

  await render();

  // Written, not merely redirected past.
  expect(chooseOrganization).toHaveBeenCalledWith(ONLY.id);
  // And no picker was ever drawn — the person was not asked to confirm a decision nobody made.
  expect(host.textContent).not.toContain("Acme Games");
});

test("several memberships draw the picker, and choosing one writes it", async () => {
  listOrganizations.mockResolvedValue({
    ok: true,
    value: { organizations: [ONLY, OTHER], acting: null, chosen: false },
  });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: OTHER.id, chosen: true } });

  await render();
  expect(host.textContent).toContain("Acme Games");
  expect(host.textContent).toContain("Beta Studio");

  const buttons = [...host.querySelectorAll("button")];
  const beta = buttons.find((button) => button.textContent?.includes("Beta Studio"));
  await act(async () => {
    beta?.click();
  });
  expect(chooseOrganization).toHaveBeenCalledWith(OTHER.id);
});

test("**it leaves by a document load, never by an in-app navigation**", async () => {
  listOrganizations.mockResolvedValue({
    ok: true,
    value: { organizations: [ONLY, OTHER], acting: null, chosen: false },
  });
  chooseOrganization.mockResolvedValue({ ok: true, value: { organizationId: ONLY.id, chosen: true } });

  await render();
  const acme = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme Games"));
  await act(async () => {
    acme?.click();
  });

  expect(assign).toHaveBeenCalledWith("/");
  // The half that goes red if somebody reaches for `navigate()` — which is what `router.tsx` offers and
  // what every other screen here correctly uses.
  expect(pushState).not.toHaveBeenCalled();
});

test("belonging nowhere is its own answer, not an empty picker", async () => {
  listOrganizations.mockResolvedValue({ ok: true, value: { organizations: [], acting: null, chosen: false } });

  await render();

  expect(host.textContent).toContain("No accounts yet");
  // Nothing was chosen, and nothing was written. There is nothing to choose.
  expect(chooseOrganization).not.toHaveBeenCalled();
  expect(assign).not.toHaveBeenCalled();
});

test("a refused choice stays on the screen rather than leaving for an account nobody has", async () => {
  // Including the ordinary 404 somebody naming an account they do not belong to gets — which is the
  // same answer an account that does not exist gets, deliberately.
  listOrganizations.mockResolvedValue({
    ok: true,
    value: { organizations: [ONLY, OTHER], acting: null, chosen: false },
  });
  chooseOrganization.mockResolvedValue({
    ok: false,
    failure: { code: "organization/not_found", message: "That organization does not exist.", action: null },
  });

  await render();
  const acme = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Acme Games"));
  await act(async () => {
    acme?.click();
  });

  expect(assign).not.toHaveBeenCalled();
  expect(host.textContent).toContain("couldn't load your accounts");
});
