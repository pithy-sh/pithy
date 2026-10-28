// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

/**
 * **The widget is solved for the action the projection names, and states none of its own.**
 *
 * Turnstile bakes an action label into the token when the widget renders, and siteverify echoes it
 * back; the sign-in route asserts it. One contract, two ends. `src/turnstile.tsx` is yours to edit,
 * and the one edit it must never take is retyping that label as a literal.
 *
 * ## Why nothing you run before production can catch the two drifting apart
 *
 * `pithy turnstile provision` wires Cloudflare's documented **always-pass test secret** into dev and
 * staging, and that secret's siteverify answer carries **no `action` field at all**. The gate accepts
 * exactly that answer in exactly those environments. So in every environment you develop or test in,
 * there is no action coming back to compare, and two strings that disagree behave precisely like two
 * that agree.
 *
 * The first environment that can tell is production. There a real widget echoes what it was solved
 * for, and a mismatch refuses **every** sign-in with a 403 that truthfully says the challenge failed
 * — which sends whoever is paged to the user, the sitekey and the secret, in that order, and to the
 * mismatch last. That is the whole reason this file exists rather than a comment asking nicely.
 *
 * ## What this proves, and how it goes red
 *
 * The projection is mocked with an action that is **deliberately not** the real one. A widget that
 * read a literal of its own would render that literal, and this goes red; only a widget that renders
 * what it was handed can pass. The expected value is invented here and reachable from nowhere else,
 * which is what a canary is for — asserting the real action would pass against the very bug this
 * catches.
 *
 * This is the widget half. That the *route* asserts the action the projection carries is the kit's
 * own gate, in `@pithy-sh/auth`. Neither is sufficient alone: this one says the widget carries what
 * it is told, that one says the server expects what is told.
 */

/**
 * The action the mocked projection carries. Not the real one, on purpose: it is the difference
 * between proving the widget *reads* the projection and proving only that two literals happen to
 * match.
 */
const CANARY_ACTION = "pithy-gate-canary-not-a-real-action";

/** A sitekey to match, so a mock that never took effect fails as loudly as a widget that ignored it. */
const CANARY_SITEKEY = "0xCANARY";

/**
 * The projection, stubbed at the module the widget reads it through.
 *
 * `src/pithy-config.tsx` is mocked rather than `virtual:pithy/turnstile` because the virtual modules
 * are served by `@pithy-sh/vite` during a build and resolve nowhere else — mocking the config module
 * keeps this gate running under the plain `vitest run` a scaffolded project already has.
 */
vi.mock("./pithy-config", () => ({
  turnstileConfig: {
    enabled: true,
    sitekey: CANARY_SITEKEY,
    mode: "visible",
    action: CANARY_ACTION,
    token: { field: "cf-turnstile-response", header: null },
  },
}));

// React refuses to run `act` unless the environment says it is a test one.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The options the component handed `turnstile.render`, or null if it never rendered a widget. */
let rendered: { sitekey: string; action: string } | null = null;

/** Every call into the widget API, in order. */
let calls: string[] = [];

/** Whether the stubbed script load fails. */
let scriptFails = false;

beforeEach(() => {
  rendered = null;
  calls = [];
  scriptFails = false;
  // The module remembers its one script load, so each case imports a fresh copy.
  vi.resetModules();
  // The component loads Cloudflare's script by appending it to `<head>` and awaiting `onload`. Nothing
  // in a test environment can serve it, so the append is intercepted: no element is added, no request
  // is made, and the handler the component just assigned is called as if the script had arrived.
  vi.spyOn(document.head, "appendChild").mockImplementation(<T extends Node>(node: T): T => {
    queueMicrotask(() => {
      const element = node as unknown as HTMLScriptElement;
      if (scriptFails) element.onerror?.(new Event("error"));
      else element.onload?.(new Event("load"));
    });
    return node;
  });
  let widgets = 0;
  window.turnstile = {
    render: (_element, options) => {
      rendered = { sitekey: options.sitekey, action: options.action };
      widgets += 1;
      calls.push(`render widget-${widgets}`);
      return `widget-${widgets}`;
    },
    remove: (widget) => {
      calls.push(`remove ${widget}`);
    },
  };
});

/** Mount the widget with `onToken` and let the script promise settle. */
async function mountWidget(onToken: (value: string | null) => void) {
  const { Turnstile } = await import("./turnstile");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (next: (value: string | null) => void) => {
    await act(async () => {
      root.render(<Turnstile onToken={next} />);
    });
    await act(async () => {
      await Promise.resolve();
    });
  };
  await render(onToken);
  return { root, render };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.turnstile = undefined;
});

test("the widget is solved for the action the projection carries, not one of its own", async () => {
  // The one place the kit's default action may appear: as the value the expectation must NOT be. A
  // canary that drifted onto a real action would pass against the drift it exists to catch.
  expect(CANARY_ACTION).not.toBe("login");

  // Imported inside the case so the mocked config module is in place before the widget's module scope
  // reads it.
  const { Turnstile } = await import("./turnstile");
  const host = document.createElement("div");
  document.body.appendChild(host);

  await act(async () => {
    createRoot(host).render(<Turnstile onToken={() => {}} />);
  });
  // One more turn for the script promise's continuation, which is where `render` is called.
  await act(async () => {
    await Promise.resolve();
  });

  expect(rendered, "the widget never rendered — the config mock or the script stub did not take").not.toBeNull();
  expect(rendered?.sitekey).toBe(CANARY_SITEKEY);
  expect(rendered?.action).toBe(CANARY_ACTION);
});

test("unmounting the widget removes the one it rendered", async () => {
  const { root } = await mountWidget(() => {});
  expect(calls).toEqual(["render widget-1"]);
  await act(async () => root.unmount());
  expect(calls).toEqual(["render widget-1", "remove widget-1"]);
});

test("a new onToken removes the old widget before it renders the next", async () => {
  const { root, render } = await mountWidget(() => {});
  await render(() => {});
  expect(calls).toEqual(["render widget-1", "remove widget-1", "render widget-2"]);
  await act(async () => root.unmount());
});

test("a script that fails to load answers null and renders no widget", async () => {
  scriptFails = true;
  const onToken = vi.fn();
  const { root } = await mountWidget(onToken);
  await act(async () => {
    await Promise.resolve();
  });
  expect(onToken).toHaveBeenCalledWith(null);
  expect(calls).toEqual([]);
  await act(async () => root.unmount());
});
