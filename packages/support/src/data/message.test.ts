// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { SupportMessage } from "./message";

/**
 * The one cross-field rule on a message row, stated as an invariant and enforced where every writer
 * already goes.
 *
 * **`emailJobId` answers exactly one question: which `pithy_email_jobs` row this was enqueued as.**
 * It is not a way to ask whether a reply went out — the moment a reply can be delivered in the app
 * rather than by mail, a null job id would mean either "this arrived" or "this was never sent", and a
 * client would have to read `direction` to tell them apart. `channel` already says how a message
 * travelled, so the rule is that the job id is present exactly when the message travelled by mail on
 * the way out, and absent otherwise.
 *
 * The check lives on the schema rather than in `reply/send.ts` because the schema is what every
 * producer passes through: ingest, submission, the reply path, the seeds, and any future writer. A
 * rule written at one call site gets a second caller that does not know about it.
 */

const AT = new Date("2026-06-10T12:00:00.000Z");

/** A message row with everything the invariant does not care about already filled in. */
function message(over: Partial<SupportMessage>): SupportMessage {
  return {
    id: "m-1",
    threadId: "t-1",
    direction: "inbound",
    channel: "email",
    submittedByUserId: null,
    context: null,
    mimeMessageId: null,
    mimeInReplyTo: null,
    mimeReferences: null,
    fromAddress: "ada@example.test",
    fromName: null,
    toAddress: "support@acme.test",
    subject: "Where is my refund?",
    textBody: "Still waiting.",
    htmlBody: null,
    emailJobId: null,
    rawKey: null,
    rawBytes: null,
    receivedAt: AT,
    createdAt: AT,
    ...over,
  };
}

describe("a message row states how it travelled, and the job id follows from that", () => {
  test("the four rows the model actually produces all encode", () => {
    const rows: SupportMessage[] = [
      // Inbound mail.
      message({}),
      // An in-app submission.
      message({ channel: "app", toAddress: null, submittedByUserId: "u-1" }),
      // A reply that went out by mail.
      message({ direction: "outbound", channel: "email", emailJobId: "job-1" }),
      // A reply stored for the app, which has no envelope and no job.
      message({ direction: "outbound", channel: "app", fromAddress: null, toAddress: null }),
    ];
    for (const row of rows) expect(() => SupportMessage.encode(row)).not.toThrow();
  });

  test("a job id on a message that did not go out by mail is refused", () => {
    // Every shape that would make `emailJobId` mean something other than "the job this was enqueued
    // as" — an inbound row claiming one, and an in-app reply claiming one.
    for (const row of [
      message({ emailJobId: "job-1" }),
      message({ direction: "outbound", channel: "app", fromAddress: null, toAddress: null, emailJobId: "job-1" }),
    ]) {
      expect(() => SupportMessage.encode(row)).toThrow(/emailJobId/);
    }
  });

  test("a reply that went out by mail without a job id is refused", () => {
    // The row is written after the enqueue is accepted, so an outbound mail row with no job id is a
    // reply nothing was ever asked to send.
    expect(() => SupportMessage.encode(message({ direction: "outbound", channel: "email" }))).toThrow(/emailJobId/);
  });

  test("a message with no sender address is refused unless it had no envelope to have one", () => {
    // `fromAddress` is null on exactly one row the model produces: the answer `sendReply` stores in the
    // app, which was never mailed. Everything else came from an address or went out from one, and a
    // null there is a thread nobody can reply to — `sendReply` reads the thread's `fromAddress` to
    // address the answer.
    for (const row of [
      // Inbound mail with no sender.
      message({ fromAddress: null }),
      // A reply that went out by mail, from nowhere.
      message({ direction: "outbound", channel: "email", emailJobId: "job-1", fromAddress: null }),
      // An in-app submission, which carries the account's address.
      message({ channel: "app", toAddress: null, submittedByUserId: "u-1", fromAddress: null }),
      // Omitted rather than null. The column is nullish, so a writer that simply never set the field
      // reaches the check as `undefined`, and absent is absent.
      message({ fromAddress: undefined }),
    ]) {
      expect(() => SupportMessage.encode(row)).toThrow(/fromAddress/);
    }
  });

  test("an address on an answer that was never mailed is refused too", () => {
    // The other direction, and the reason the rule is not "present unless in-app". Putting the
    // deployment's own address on a reply that was stored rather than sent claims a send that did not
    // happen, to every projection that renders the column.
    expect(() => SupportMessage.encode(message({ direction: "outbound", channel: "app", toAddress: null }))).toThrow(
      /fromAddress/,
    );
  });

  test("the rule holds on the way back out of D1, not only on the way in", () => {
    // A row that reached the table before this rule existed, or by any path that did not go through
    // `encode`, must not be handed to a projection that would render it as sent.
    const mailed = SupportMessage.encode(message({ direction: "outbound", channel: "email", emailJobId: "job-1" }));
    expect(() => SupportMessage.parse({ ...mailed, emailJobId: null })).toThrow(/emailJobId/);
    expect(() => SupportMessage.parse({ ...mailed, fromAddress: null })).toThrow(/fromAddress/);
  });
});
