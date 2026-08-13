// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { PAYMENTS_HOSTED_RAILS, type PaymentsClientRail } from "@pithy-sh/payments/src/client/api";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test } from "vitest";
import { SubscriptionScreen } from "../templates/src/routes/pithy/subscription";

/**
 * The scaffolded subscription screen, rendered against one project shape at a time.
 *
 * #336: this screen gated "Manage billing" on `rails.stripe || rails.lemonSqueezy`, so a Paddle-only
 * project scaffolded a subscription page with no way to reach a portal — while the server minted one
 * happily. It was the third hand-written copy of the same list, and the comment above it documented the
 * second time the same thing happened.
 *
 * A source-text assertion cannot catch that class. What the screen *renders* for a given set of enabled
 * rails is the fact, so the file is mounted against a DOM and asked. The loop over
 * `PAYMENTS_HOSTED_RAILS` is what makes it hold for the next rail too: a fourth one added to the package
 * enters this test with it, and if the screen were still naming rails by hand the new member would
 * arrive here with nothing rendering for it.
 */

// React refuses to run `act` unless the environment says it is a test one. See `signIn.test.tsx`.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Every rail off. Each case switches on exactly what it is about. */
const NONE: Record<PaymentsClientRail, boolean> = {
  apple: false,
  google: false,
  stripe: false,
  lemonSqueezy: false,
  paddle: false,
};

/** A fetch that answers the entitlements read with an empty list and records nothing else. */
const answered: typeof fetch = (async () => Response.json({ entitlements: [] })) as unknown as typeof fetch;

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

/** Render the screen for one project's rails, and hand back the buttons it drew. */
async function buttons(rails: Record<PaymentsClientRail, boolean>): Promise<string[]> {
  const container = await mount(<SubscriptionScreen rails={rails} client={{ fetch: answered }} />);
  // The loading branch renders no buttons at all, so a test that never resolved the read would report
  // "no Manage billing" and pass the negative cases for the wrong reason. The heading proves it settled.
  expect(container.querySelector("h1"), "the screen is still loading — the read never resolved").not.toBeNull();
  return [...container.querySelectorAll("button")].map((button) => button.textContent ?? "");
}

describe("the scaffolded subscription screen", () => {
  test("offers a way to manage billing on every hosted rail, one at a time", async () => {
    // A floor. If `PAYMENTS_HOSTED_RAILS` were ever empty this loop would assert nothing and pass.
    expect(PAYMENTS_HOSTED_RAILS.length).toBeGreaterThanOrEqual(3);

    for (const rail of PAYMENTS_HOSTED_RAILS) {
      const drawn = await buttons({ ...NONE, [rail]: true });
      expect(drawn, `a ${rail}-only project must be able to reach its billing portal`).toContain("Manage billing");
      mounted?.unmount();
      mounted = null;
    }
  });

  test("offers none when the project sells only inside the app stores", async () => {
    // Not an oversight and not the #336 bug in reverse: a web page cannot open a StoreKit or Play
    // Billing portal, so the two store buttons are the only management there is.
    const drawn = await buttons({ ...NONE, apple: true, google: true });
    expect(drawn).not.toContain("Manage billing");
    expect(drawn).toEqual(["Bought on the App Store", "Bought on Google Play"]);
  });

  test("offers nothing when no rail is on", async () => {
    expect(await buttons(NONE)).toEqual([]);
  });

  test("offers exactly one billing button when several hosted rails are on", async () => {
    // The server picks the rail this caller actually bought on, from the account map. A button per rail
    // would ask the buyer a question they cannot answer.
    const rails = { ...NONE };
    for (const rail of PAYMENTS_HOSTED_RAILS) rails[rail] = true;
    const drawn = await buttons(rails);
    expect(drawn.filter((label) => label === "Manage billing")).toHaveLength(1);
  });
});
