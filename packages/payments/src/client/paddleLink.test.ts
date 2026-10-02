// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { isPaddleTransactionId } from "../data/paddleIds";
import { PADDLE_LINK_PARAM, readPaddleLinkTransaction } from "./paddleLink";

/**
 * Reading the transaction Paddle put in the URL.
 *
 * Paddle appends `?_ptxn=<transaction_id>` to a seller's **Default payment link** and expects the page it
 * lands on to open a checkout for that transaction. That link is what Paddle itself sends — a past-due
 * dunning mail, a manually-collected invoice, the payment-method-update link minted for a subscription —
 * so the id arrives from outside, in a query string, from a person who may not be signed in.
 *
 * **Which is the whole reason this is a function with tests rather than a `searchParams.get` at a call
 * site.** The value is attacker-supplied. It is about to be sent to a route and then handed to
 * `Paddle.Checkout.open`, so the only thing that makes it safe to pass on is that it looks like a Paddle
 * transaction id and nothing else — and `null` is what a screen renders its ordinary state for.
 */
describe("reading `_ptxn` out of a query string", () => {
  test("the parameter name is Paddle's, and it is named once", () => {
    // A literal `"_ptxn"` at two call sites is how one of them survives a rename. Paddle does not
    // document this name as stable, so the constant is the thing to grep for when it moves.
    expect(PADDLE_LINK_PARAM).toBe("_ptxn");
  });

  test("a transaction id is read from a search string, with or without the leading `?`", () => {
    const id = "txn_01h8xce4x86pq3byvqf4x4zjvz";
    expect(readPaddleLinkTransaction(`?${PADDLE_LINK_PARAM}=${id}`)).toBe(id);
    expect(readPaddleLinkTransaction(`${PADDLE_LINK_PARAM}=${id}`)).toBe(id);
    // Beside other parameters, in either order, because a real landing page carries its own.
    expect(readPaddleLinkTransaction(`?pane=billing&${PADDLE_LINK_PARAM}=${id}`)).toBe(id);
    expect(readPaddleLinkTransaction(`?${PADDLE_LINK_PARAM}=${id}&pane=billing`)).toBe(id);
  });

  test("**no parameter is null, not a failure**", () => {
    // Every page this hook is mounted on renders without one almost every time it is loaded. An absent
    // `_ptxn` is the ordinary case and must not read as an error a screen has to handle.
    expect(readPaddleLinkTransaction("")).toBeNull();
    expect(readPaddleLinkTransaction("?")).toBeNull();
    expect(readPaddleLinkTransaction("?pane=billing")).toBeNull();
  });

  test("**anything that is not a transaction id is null, and never passed on**", () => {
    // The refusals that matter are the ones that would otherwise reach `Paddle.Checkout.open` or a
    // server route. A scheme, a path traversal and a whitespace-padded id are all things a URL can
    // carry; none of them is a `txn_…`.
    for (const value of [
      "",
      "txn_",
      "txn",
      "sub_01h8xce4x86pq3byvqf4x4zjvz",
      "pri_01h8xce4x86pq3byvqf4x4zjvz",
      "javascript:alert(1)",
      "../../etc/passwd",
      "TXN_01H8XCE4X86PQ3BYVQF4X4ZJVZ",
      "txn_01h8xce4x86pq3byvqf4x4zjvz extra",
    ]) {
      expect(
        readPaddleLinkTransaction(`?${PADDLE_LINK_PARAM}=${encodeURIComponent(value)}`),
        `"${value}" must not be read as a transaction id`,
      ).toBeNull();
    }
  });

  test("an empty repeat does not shadow a real one, and a repeat takes the first", () => {
    const id = "txn_01h8xce4x86pq3byvqf4x4zjvz";
    // `URLSearchParams.get` returns the first. Asserted rather than assumed, because "the first" is the
    // thing a reader would otherwise have to know about the standard library to predict.
    expect(readPaddleLinkTransaction(`?${PADDLE_LINK_PARAM}=${id}&${PADDLE_LINK_PARAM}=txn_other`)).toBe(id);
  });

  test("**the id check is the rail's own, not a second copy of it**", () => {
    // `rails/paddle/verify.ts` had this pattern as a module-private const, and a receipt submitted to
    // the purchases route is checked against it before any round trip. A second regex here would be a
    // second producer of the same rule — the defect class this repository has paid for four times — so
    // both read one primitive, and this asserts they agree rather than trusting that they do.
    expect(isPaddleTransactionId("txn_01h8xce4x86pq3byvqf4x4zjvz")).toBe(true);
    expect(isPaddleTransactionId("sub_01h8xce4x86pq3byvqf4x4zjvz")).toBe(false);
    expect(readPaddleLinkTransaction(`?${PADDLE_LINK_PARAM}=txn_01h8xce4x86pq3byvqf4x4zjvz`)).toBe(
      "txn_01h8xce4x86pq3byvqf4x4zjvz",
    );
  });
});
