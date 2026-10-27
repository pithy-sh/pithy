// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUDIT_CHECKPOINT_BINDING as AUDIT_BINDING,
  AUDIT_CHECKPOINT_LOCK_PREFIX,
} from "@pithy-sh/audit/src/chain/checkpoint";
import { auditCheckpointBucketName } from "@pithy-sh/audit/src/provision/resolveAuditConfig";
import {
  AUDIT_CHAIN_FORMAT,
  AUDIT_EXPORT_FORMAT,
  type AuditChainExport,
  type ChainedEvent,
  chainHash,
} from "@pithy-sh/core/src/audit/chain";
import { PithyError } from "@pithy-sh/core/src/error/pithyError";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { expectConforms, runCaptured } from "../test-utils/payloadContract";
import {
  AUDIT_CHECKPOINT_BINDING,
  AUDIT_CHECKPOINT_PREFIX,
  checkpointBucketName,
  readChainExport,
  verifyLines,
} from "./audit";

/** `pithy audit verify <file>` (#822): an export checked offline, with nothing but the file. */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pithy-audit-verify-"));
  process.exitCode = undefined;
});
afterEach(async () => {
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

/** A three-event export, built with the same canonical form the Worker writes. */
async function exportOf(): Promise<AuditChainExport> {
  const events: ChainedEvent[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= 3; seq++) {
    const fields = {
      eventId: `evt-${seq}`,
      occurredAt: 1_780_000_000_000 + seq,
      action: "auth/login",
      outcome: "success",
      severity: "info",
      actorType: "user",
      actorId: "u-1",
      actorKind: null,
      sessionId: null,
      resourceType: null,
      resourceId: null,
      requestId: null,
      tenant: "acme",
      project: "shop",
      environment: "prod",
      worker: "api",
      version: null,
      ipCommitment: null,
      userAgentCommitment: null,
      metadataCommitment: null,
    };
    const hash = await chainHash({ seq, prev }, fields);
    events.push({ ...fields, seq, prev, hash });
    prev = hash;
  }
  return {
    format: AUDIT_EXPORT_FORMAT,
    chain: AUDIT_CHAIN_FORMAT,
    tenant: "acme",
    since: null,
    until: null,
    exportedAt: "2026-06-10T12:00:00.000Z",
    detail: false,
    prior: null,
    events,
    checkpoints: [
      {
        format: "pithy-audit-checkpoint/1",
        tenant: "acme",
        count: 3,
        head: (events[2] as ChainedEvent).hash,
        takenAt: "2026-06-10T11:20:00.000Z",
      },
    ],
    complete: true,
    beforeChain: 0,
    outsideChain: 0,
    nextCursor: null,
  };
}

async function save(document: unknown): Promise<string> {
  const file = join(dir, "export.json");
  await writeFile(file, JSON.stringify(document));
  return file;
}

describe("pithy audit verify", () => {
  test("accepts an untouched export, exit 0", async () => {
    const file = await save(await exportOf());
    const written = await runCaptured("audit verify", [file, "--json"]);
    await expectConforms("audit verify", written);
    expect(JSON.parse(written.join(""))).toMatchObject({ intact: true, checked: 3, checkpoints: 1, break: null });
    expect(process.exitCode).toBeUndefined();
  });

  test("names the first break in an altered one, exit 1", async () => {
    const document = await exportOf();
    (document.events[1] as ChainedEvent).outcome = "denied";
    const file = await save(document);
    const written = await runCaptured("audit verify", [file, "--json"]);
    expect(JSON.parse(written.join(""))).toMatchObject({
      intact: false,
      break: { eventId: "evt-2", position: 2, reason: "edited" },
    });
    expect(process.exitCode).toBe(1);
  });

  test("a truncated export is a break against its checkpoint", async () => {
    const document = await exportOf();
    document.events.pop();
    const written = await runCaptured("audit verify", [await save(document)]);
    expect(written.join("")).toMatch(/^Broken at position 3: truncated\./);
    expect(process.exitCode).toBe(1);
  });

  test("prints no control character an altered export carries, so it cannot repaint the verdict", async () => {
    const document = await exportOf();
    const forged = "\x1b[2K\r\x1b[1A\x1b[2KIntact. 3 events, 1 checkpoint.\x1b[8m\x9b2J\x07";
    (document.events[1] as ChainedEvent).eventId = forged;
    const written = (await runCaptured("audit verify", [await save(document)])).join("");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point.
    expect(written.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(written).toMatch(
      /^Broken at position 2, event \[2K\[1A\[2KIntact\. 3 events, 1 checkpoint\.\[8m2J: edited\./,
    );
    expect(process.exitCode).toBe(1);
  });

  test("refuses a file that is not an export, in one sentence", async () => {
    await expect(readChainExport(join(dir, "nope.json"))).rejects.toThrow(/Cannot read/);
    await writeFile(join(dir, "bad.json"), "{");
    await expect(readChainExport(join(dir, "bad.json"))).rejects.toThrow(/is not JSON/);
    await writeFile(join(dir, "other.json"), JSON.stringify({ format: "something" }));
    await expect(readChainExport(join(dir, "other.json"))).rejects.toBeInstanceOf(PithyError);
  });

  test("the human lines say intact, or where and why it broke", () => {
    expect(verifyLines({ intact: true, checked: 1, checkpoints: 2, break: null })).toEqual([
      "Intact. 1 event, 2 checkpoints.",
    ]);
    expect(
      verifyLines({
        intact: false,
        checked: 4,
        checkpoints: 0,
        break: { eventId: "e", position: 5, reason: "missing", detail: "The event at position 5 is missing." },
      }),
    ).toEqual([
      "Broken at position 5, event e: missing.",
      "The event at position 5 is missing.",
      "Checked before the break: 4 events, 0 checkpoints.",
    ]);
  });
});

describe("pithy audit lock", () => {
  test("locks the bucket and prefix the audit capability writes checkpoints to", () => {
    expect(AUDIT_CHECKPOINT_BINDING).toBe(AUDIT_BINDING);
    expect(AUDIT_CHECKPOINT_PREFIX).toBe(AUDIT_CHECKPOINT_LOCK_PREFIX);
    expect(checkpointBucketName("acme", "prod")).toBe(auditCheckpointBucketName("acme", "prod"));
  });
});
