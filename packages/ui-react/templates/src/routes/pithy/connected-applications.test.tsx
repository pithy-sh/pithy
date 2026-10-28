// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * **The list says which part of an application's identity is checked, and never says it of the name.**
 *
 * An application names itself, so its name is whatever it said. A host its metadata document proved is checked. A
 * restyle that moves "That is checked." onto the name, or drops the host as clutter, tells a person a self-asserted
 * name was verified, and every manual test uses the adopter's own application, so nothing looks wrong. The gate
 * renders an invented name and host and asserts where each lands.
 */

const NAME_CANARY = "Canary Official Sync";
const HOST_CANARY = "canary-client.example.com";
const CLIENT_CANARY = `https://${HOST_CANARY}/oauth/client.json`;
const REDIRECT_CANARY = "http://127.0.0.1:4317/canary-callback";

const { listConnectedApplications, revokeConnectedApplication } = vi.hoisted(() => ({
  listConnectedApplications: vi.fn(),
  revokeConnectedApplication: vi.fn(),
}));

vi.mock("@pithy-sh/auth/src/client/mcp", () => ({ listConnectedApplications, revokeConnectedApplication }));

let host: HTMLElement;

function application(verifiedHost: string | null) {
  return {
    clientId: CLIENT_CANARY,
    verifiedHost,
    reportedName: NAME_CANARY,
    redirectUris: [REDIRECT_CANARY],
    approvedAt: "2026-10-01T12:00:00.000Z",
  };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  listConnectedApplications.mockReset();
  revokeConnectedApplication.mockReset();
  listConnectedApplications.mockResolvedValue({ ok: true, value: [application(HOST_CANARY)] });
  revokeConnectedApplication.mockResolvedValue({ ok: true, value: { revoked: true } });
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

async function rendered(): Promise<() => void> {
  const { default: ConnectedApplications } = await import("./connected-applications");
  const root = createRoot(host);
  await act(async () => {
    root.render(<ConnectedApplications />);
  });
  await act(async () => {});
  return () => root.unmount();
}

function leavesContaining(text: string): Element[] {
  return [...host.querySelectorAll("*")].filter(
    (element) => element.children.length === 0 && (element.textContent ?? "").includes(text),
  );
}

test("a host its metadata document proved is shown as checked, and the name beside it is never", async () => {
  // Invented values, so a screen that hard-coded a real application's name or host cannot pass by accident.
  expect(NAME_CANARY).not.toBe("");
  expect(HOST_CANARY).not.toBe("");
  const unmount = await rendered();
  expect(leavesContaining(`Published at ${HOST_CANARY}. That is checked.`)).toHaveLength(1);
  const names = leavesContaining(NAME_CANARY);
  expect(names.length).toBeGreaterThan(0);
  for (const element of names) expect(element.textContent).not.toMatch(/checked/i);
  expect(host.textContent).toContain(REDIRECT_CANARY);
  unmount();
});

test("an application nothing verified shows no checked line", async () => {
  listConnectedApplications.mockResolvedValue({ ok: true, value: [application(null)] });
  const unmount = await rendered();
  expect(host.textContent).toContain(NAME_CANARY);
  expect(host.textContent).not.toMatch(/checked/i);
  unmount();
});

test("revoking sends the application's id, a URL for a metadata-document client, as it was listed", async () => {
  const unmount = await rendered();
  const button = [...host.querySelectorAll("button")].find((element) => element.textContent === "Revoke");
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  expect(revokeConnectedApplication).toHaveBeenCalledTimes(1);
  expect(revokeConnectedApplication.mock.calls[0]?.[0]).toBe(CLIENT_CANARY);
  unmount();
});
