// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { pluginSchemaDelta } from "../migrations/pluginTables";
import { clientMetadataDiscovery } from "./clientMetadata";
import { mcpAuthorizationServer } from "./provider";
import { PROVIDER_SCHEMA } from "./providerSchema";

describe("PROVIDER_SCHEMA", () => {
  test("is what the oauth-provider plugin's own schema derives", () => {
    const [provider] = mcpAuthorizationServer({
      resource: "https://schema.invalid/mcp",
      consentPage: "/agent-consent",
      clientDiscovery: clientMetadataDiscovery(),
    });
    expect(PROVIDER_SCHEMA).toEqual(pluginSchemaDelta(provider));
  });
});
