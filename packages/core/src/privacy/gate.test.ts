// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { z } from "zod";
import type { AuditEmit } from "../audit/recorder";
import { InternalError, NotFoundError, PithyError, ValidationError } from "../error/pithyError";
import { createLogger, type Logger, noopLogger } from "../logger/logger";
import type { LogRecord } from "../logger/record";
import { phi, pii, secret } from "./classes";
import { redact } from "./redact";
import type { ContainsMarked, IsMarked, Redacted, UnmarkedString } from "./types";

/**
 * **The type gate, held by the compiler** (#132).
 *
 * Every `@ts-expect-error` below is an assertion `bun run typecheck` makes: a line that stops failing fails the
 * build, because an unused `@ts-expect-error` is itself an error. The runtime tests beside them prove the calls
 * that are meant to compile still do what they did.
 */

const User = z
  .object({
    id: z.string().describe("The user's stable id."),
    email: pii(z.string().describe("The address sign-in links are sent to.")),
    diagnosis: phi(z.string().describe("The recorded condition.")),
  })
  .describe("A user.");
type User = z.output<typeof User>;

const Session = z
  .object({ token: secret(z.string().describe("The bearer.")), user: User.describe("Who it is.") })
  .describe("A session.");
type Session = z.output<typeof Session>;

const user: User = User.parse({ id: "u_1", email: "ada@example.com", diagnosis: "asthma" });
const session: Session = Session.parse({ token: "tok", user });

/** Never run — the compiler checks the body. Each refused call names the rule it breaks. */
function compileOnly(log: Logger, emit: AuditEmit): void {
  // @ts-expect-error a row with a marked field cannot be logged
  log.info("signup", { user });
  // @ts-expect-error the brand is on the field, so extracting it does not launder it
  log.info("signup", { email: user.email });
  // @ts-expect-error two levels down: a session holding a user holding an email
  log.warn("session", { session });
  // @ts-expect-error inside a literal object
  log.error("signup", { who: { email: user.email } });
  // @ts-expect-error inside an array
  log.debug("batch", { users: [user] });
  // @ts-expect-error bound fields on a child are a log call too
  log.child("signup", { user });
  // @ts-expect-error audit metadata is a long-lived internal surface
  void emit({ action: "auth/signup", outcome: "success", actorType: "user", metadata: { email: user.email } });
  // @ts-expect-error a marked value is not an error detail
  void new InternalError({ detail: user.email });
  // @ts-expect-error on every subclass, because they share the one argument type
  void new NotFoundError({ detail: user.diagnosis });
  // @ts-expect-error nor on a payload handed to PithyError directly
  void new PithyError({ code: "core/internal", status: 500, message: "x", detail: user.email });

  log.info("signup", { id: user.id });
  log.info("signup", { user: redact(User, user) });
  log.child("signup", { userId: user.id }).info("done");
  void emit({ action: "auth/signup", outcome: "success", actorType: "user", metadata: { userId: user.id } });
  void new ValidationError({ detail: `user ${user.id} sent a bad form` });
  void new InternalError({ detail: "plain" });
}

describe("the type gate", () => {
  test("is a compile-time gate: the calls it allows still log exactly what they did", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "debug", sink: (record) => records.push(record), now: () => 1 });
    log.info("signup", { id: user.id, user: redact(User, user) });
    expect(records[0]?.fields).toEqual({ id: "u_1", user: { id: "u_1", email: "[pii]", diagnosis: "[phi]" } });
    expect(typeof compileOnly).toBe("function");
    noopLogger.info("unchanged", { id: user.id });
  });

  test("reads a privacy brand and nothing else", () => {
    const branded: IsMarked<User["email"]> = true;
    const plain: IsMarked<string> = false;
    const otherBrand: IsMarked<string & z.core.$brand<"UserId">> = false;
    const anyValue: IsMarked<ReturnType<typeof JSON.parse>> = false;
    const deep: ContainsMarked<{ a: { b: { c: User } } }> = true;
    // Six levels below the field is the last one inspected; a seventh is not. See PRIVACY_CHECK_DEPTH.
    const sixth: ContainsMarked<{ l1: { l2: { l3: { l4: { l5: { email: User["email"] } } } } } }> = true;
    const seventh: ContainsMarked<{ l1: { l2: { l3: { l4: { l5: { l6: { email: User["email"] } } } } } } }> = false;
    const unknownValue: ContainsMarked<unknown> = false;
    const errorValue: ContainsMarked<Error> = false;
    expect([branded, plain, otherBrand, anyValue, deep, sixth, seventh, unknownValue, errorValue]).toEqual([
      true,
      false,
      false,
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test("a redacted value carries no brand, and a detail takes an unmarked string", () => {
    const masked: Redacted<User> = redact(User, user);
    const contains: ContainsMarked<typeof masked> = false;
    const detail: UnmarkedString = `user ${masked.email}`;
    expect([contains, detail]).toEqual([false, "user [pii]"]);
  });
});
