// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test, vi } from "vitest";

/** The Expo config the template answers, with `src/pithy-config.generated.ts` naming `universalLinkOrigin`. */
async function expoConfig(universalLinkOrigin: string | null) {
  vi.doMock("../templates/src/pithy-config.generated", () => ({
    default: { appScheme: "pithyapp", universalLinkOrigin, google: { webClientId: null, iosClientId: null } },
  }));
  const { default: config } = await import("../templates/app.config");
  return config();
}

afterEach(() => {
  vi.doUnmock("../templates/src/pithy-config.generated");
  vi.resetModules();
});

describe("the app's universal link", () => {
  test("with none set, the app claims no https host on either platform", async () => {
    const config = await expoConfig(null);
    expect(config.ios?.associatedDomains).toEqual([]);
    expect(config.android?.intentFilters).toEqual([]);
  });

  test("once set, iOS and Android both claim its host", async () => {
    const config = await expoConfig("https://links.example.com");
    expect(config.ios?.associatedDomains).toEqual(["applinks:links.example.com"]);
    expect(config.android?.intentFilters).toEqual([
      expect.objectContaining({ autoVerify: true, data: [{ scheme: "https", host: "links.example.com" }] }),
    ]);
  });
});
