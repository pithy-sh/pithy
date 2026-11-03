// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { SettingsAccountReader } from "@pithy-sh/core/src/capability/settings";
import { describe, expect, test } from "vitest";
import { support } from "../capability";
import { SupportConfig, type SupportConfigInput } from "../config/config";
import { supportSendingSettings } from "./sendingCheck";

/** A reader that answers the sending question from a set, and refuses everything else. */
function reader(sending: readonly string[], asked: string[] = []): SettingsAccountReader {
  const refuse = async () => {
    throw new Error("not asked here");
  };
  return {
    d1Databases: refuse,
    zone: refuse,
    vaultSecret: refuse,
    storeEntry: refuse,
    appRows: refuse,
    vaultSecretField: refuse,
    accountToken: refuse,
    sendingDomain: async (domain) => {
      asked.push(domain);
      return sending.includes(domain);
    },
  };
}

const context = (account: SettingsAccountReader) => ({
  project: "acme",
  worker: "acme-desk",
  workerDirectory: "desk",
  environments: [
    { name: "dev", origin: null },
    { name: "prod", origin: null },
  ],
  account,
});

function check(input: SupportConfigInput) {
  return supportSendingSettings(SupportConfig.parse(input));
}

describe("whether each inbound address's domain can send", () => {
  test("says nothing when every domain can send, asking each domain once", async () => {
    const asked: string[] = [];
    const findings = await check({
      inboundAddresses: ["support@help.example.com", "billing@help.example.com"],
    }).account?.(context(reader(["help.example.com"], asked)));
    expect(findings).toEqual([]);
    expect(asked).toEqual(["help.example.com"]);
  });

  test("names the domain and the address a reply would fail from", async () => {
    const findings = await check({
      inboundAddresses: ["support@help.example.com", "security@trust.example.com"],
    }).account?.(context(reader(["help.example.com"])));
    expect(findings).toHaveLength(1);
    expect(findings?.[0]).toMatchObject({ setting: "inboundAddresses", environment: null });
    expect(findings?.[0]?.problem).toContain("trust.example.com");
    expect(findings?.[0]?.problem).toContain("security@trust.example.com");
    expect(findings?.[0]?.action).toContain("trust.example.com");
  });

  test("asks nothing when replies are off or nothing is claimed", async () => {
    const asked: string[] = [];
    expect(
      await check({ inboundAddresses: ["support@help.example.com"], reply: { enabled: false } }).account?.(
        context(reader([], asked)),
      ),
    ).toEqual([]);
    expect(await check({}).account?.(context(reader([], asked)))).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a reader that cannot ask is an unanswered question, not a domain that cannot send", async () => {
    const { sendingDomain: _omitted, ...older } = reader([]);
    await expect(check({ inboundAddresses: ["support@help.example.com"] }).account?.(context(older))).rejects.toThrow();
  });

  test("the capability declares it", async () => {
    const capability = support({ inboundAddresses: ["support@help.example.com"], submission: { enabled: false } });
    const findings = await capability.settings?.account?.(context(reader([])));
    expect(findings?.map((finding) => finding.setting)).toEqual(["inboundAddresses"]);
  });
});
