// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { BROWSER_ITEMS_FORGERY, BROWSER_OVERWROTE_SERVER_STAMP } from "./fixtures/browserForged";
import {
  accountReferenceOf,
  accountReferenceProof,
  fencedOut,
  PADDLE_CUSTOM_ACCOUNT,
  PADDLE_CUSTOM_ENV,
  PADDLE_CUSTOM_PROOF,
} from "./objects";

/**
 * What a browser can write into `custom_data`, and what it is worth when it arrives back.
 *
 * `checkout.test.ts` covers what this deployment stamps and `routes.workers.test.ts` covers what the
 * routes do with a stamp. This file is about the attacker's half, and it runs against two objects Paddle
 * actually stored rather than two an author typed — see `fixtures/browserForged.ts` for how they were
 * produced.
 *
 * Nothing here contacts Paddle. The fixtures are the contact, made once, recorded.
 */

/** This deployment's notification-destination secret, and the only thing an attacker does not have. */
const SECRET = "pdl_ntfset_01hv8wptq8987qeep44cyrewp9_suiteonly";

describe("a stamp a browser wrote binds nobody", () => {
  test("the items[] forgery, exactly as Paddle stored it", async () => {
    // A page opened a checkout for a price it named, wrote an owner it chose, and paid. There was no
    // server call anywhere in that sentence, and this is the object that came back.
    expect(await accountReferenceOf(BROWSER_ITEMS_FORGERY, "prod", SECRET)).toBeNull();
  });

  test("the overwrite of a stamp this deployment really wrote", async () => {
    // The one that refutes the issue's premise. The transaction was created by the server, with a
    // server-written stamp on it; the browser passed `customData` beside `transactionId` and replaced it.
    // If `transactionId` protected `custom_data`, this fixture could not exist.
    expect(await accountReferenceOf(BROWSER_OVERWROTE_SERVER_STAMP, "prod", SECRET)).toBeNull();
  });

  test("both carry the right key names and the right environment — only the MAC refuses them", async () => {
    // Anti-vacuity of the strictest kind available here: the two refusals above must be the MAC failing
    // and not a missing key or a wrong environment, or they would prove nothing about the MAC at all.
    for (const forged of [BROWSER_ITEMS_FORGERY, BROWSER_OVERWROTE_SERVER_STAMP]) {
      expect(Object.keys(forged).sort()).toEqual(
        [PADDLE_CUSTOM_ACCOUNT, PADDLE_CUSTOM_ENV, PADDLE_CUSTOM_PROOF].sort(),
      );
      expect(forged[PADDLE_CUSTOM_ENV]).toBe("prod");
      expect(typeof forged[PADDLE_CUSTOM_ACCOUNT]).toBe("string");

      // And with the one value they could not produce, the identical object is honoured. So the field
      // that decides is the proof, and every other field in these fixtures is already right.
      const reference = String(forged[PADDLE_CUSTOM_ACCOUNT]);
      const proven = { ...forged, [PADDLE_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", SECRET) };
      expect(await accountReferenceOf(proven, "prod", SECRET)).toBe(reference);
    }
  });

  test("neither is fenced out, so the refusal is authorization and not the environment stamp", async () => {
    // `fencedOut` is a fence between deployments sharing one sandbox, not an authorization — it reads
    // unauthenticated `custom_data` on purpose. Both fixtures name this deployment's environment, so the
    // fence lets them through and `accountReferenceOf` is what stops them. Were it otherwise, the two
    // refusals above would be a forger declining to be projected rather than a forgery being caught.
    expect(fencedOut(BROWSER_ITEMS_FORGERY, "prod")).toBe(false);
    expect(fencedOut(BROWSER_OVERWROTE_SERVER_STAMP, "prod")).toBe(false);
  });

  test("a deployment that does not know its own environment trusts neither, and no proof helps", async () => {
    const reference = String(BROWSER_ITEMS_FORGERY[PADDLE_CUSTOM_ACCOUNT]);
    const proven = {
      ...BROWSER_ITEMS_FORGERY,
      [PADDLE_CUSTOM_PROOF]: await accountReferenceProof(reference, "prod", SECRET),
    };
    expect(await accountReferenceOf(proven, undefined, SECRET)).toBeNull();
  });
});
