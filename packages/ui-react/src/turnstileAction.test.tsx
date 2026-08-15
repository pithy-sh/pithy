// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * **The widget is solved for the action the projection names, and states none of its own (#377).**
 *
 * Turnstile bakes an action label into the token at render and echoes it from siteverify; the sign-in
 * route asserts it. So the label is one contract with two ends, and it used to be typed out at both —
 * `turnstile({ action: "login" })` on the route, `const ACTION = "login"` in this template.
 *
 * ## Why nothing before production could catch them drifting apart
 *
 * `pithy turnstile provision` wires Cloudflare's documented **always-pass test secret** into dev and
 * staging, and that secret's siteverify answer carries **no `action` field at all**. The gate accepts
 * exactly that answer in exactly those two environments (#374). So in every environment anyone develops
 * or tests in, there is no action coming back to compare, and two strings that disagree behave precisely
 * like two that agree.
 *
 * The first environment that can tell is production, where a real widget echoes what it was solved for.
 * There the mismatch refuses **every** sign-in, with a 403 that truthfully says the challenge failed —
 * sending whoever is paged to look at the user, the widget, and the secret, in that order, and at the
 * mismatch last. That is the whole reason this value is not allowed a second copy, and the reason this
 * file exists rather than a comment asking nicely.
 *
 * ## What this proves, and how it can fail
 *
 * The projection is mocked with an action that is **deliberately not** the real one. A template that
 * read its own literal would render `login` and this goes red; only a template that renders what it was
 * handed can pass. The expected value is therefore not derived from anything the template generates —
 * it is a string invented here, which is exactly what a canary is for.
 *
 * The other half — that the *route* asserts the action the projection carries — is
 * `@pithy-sh/auth`'s `src/http/turnstileActionBinding.test.ts`. Neither gate is sufficient alone: this
 * one says the widget carries what it is told, that one says the server expects what is told.
 */

/**
 * The action the mocked projection carries. Not `login`, on purpose: it is the difference between
 * proving the template *reads* the projection and proving only that two literals happen to match.
 */
const CANARY_ACTION = "gate-canary-not-a-literal";

/** A sitekey to match, so a mock that never took effect fails as loudly as a template that ignored it. */
const CANARY_SITEKEY = "0xCANARY";

vi.mock("virtual:pithy/turnstile", () => ({
  default: {
    enabled: true,
    sitekey: CANARY_SITEKEY,
    mode: "visible",
    action: CANARY_ACTION,
    token: { field: "cf-turnstile-response", header: null },
  },
}));

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The options the component handed `turnstile.render`, or null if it never rendered a widget. */
let rendered: { sitekey: string; action: string } | null = null;

beforeEach(() => {
  rendered = null;
  // The component loads Cloudflare's script by appending it to `<head>` and awaiting `onload`. Nothing
  // in a test environment can serve it, so the append is intercepted: no element is added, no request is
  // made, and the handler the component just assigned is called as if the script had arrived.
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    queueMicrotask(() => (node as unknown as HTMLScriptElement).onload?.(new Event("load")));
    return node;
  });
  window.turnstile = {
    render: (_element, options) => {
      rendered = { sitekey: options.sitekey, action: options.action };
      return "widget-id";
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  window.turnstile = undefined;
});

test("the widget is solved for the action the projection carries, not one of its own", async () => {
  // Imported inside the case so the mocked virtual module is in place before the template's module
  // scope reads it through `pithy-config.tsx`.
  const { Turnstile } = await import("../templates/src/turnstile");
  const host = document.createElement("div");
  document.body.appendChild(host);

  await act(async () => {
    createRoot(host).render(<Turnstile onToken={() => {}} />);
  });
  // One more turn for the script promise's continuation, which is where `render` is called.
  await act(async () => {
    await Promise.resolve();
  });

  expect(rendered, "the widget never rendered — the projection mock or the script stub did not take").not.toBeNull();
  expect(rendered?.sitekey).toBe(CANARY_SITEKEY);
  expect(rendered?.action).toBe(CANARY_ACTION);
});
