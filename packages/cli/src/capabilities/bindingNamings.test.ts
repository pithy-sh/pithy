// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import type { BindingSpecInput } from "@pithy-sh/core/src/capability/bindings";
import { defineCapability } from "@pithy-sh/core/src/capability/capability";
import { environmentScope } from "@pithy-sh/core/src/naming/provisionScope";
import { describe, expect, test } from "vitest";
import { bindingDeclarations, resolveBindingNamings } from "./bindingNamings";

const scope = environmentScope("acme", "staging");

/** The two fields of a manifest a naming reads, parsed through the same `BindingSpec` contract. */
const manifest = (name: string, requiredBindings: BindingSpecInput[]) => {
  const parsed = defineCapability({ name, requiredBindings });
  return { name: parsed.name, requiredBindings: parsed.requiredBindings };
};

describe("bindingDeclarations", () => {
  test("adds the app's composed instance, which ships no manifest", () => {
    const app = defineCapability({
      name: "family",
      requiredBindings: [{ type: "d1", name: "LEDGER", scope: "global" }] satisfies BindingSpecInput[],
    });
    const declarations = bindingDeclarations([manifest("email", [])], app);
    expect(declarations.map((declaration) => declaration.name)).toEqual(["email", "family"]);
  });

  test("lets a manifest of the app's name win over the instance", () => {
    const app = defineCapability({ name: "email", requiredBindings: [] });
    const manifests = [manifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }])];
    expect(bindingDeclarations(manifests, app)).toEqual(manifests);
  });

  test("is the manifests alone for a Worker with no app", () => {
    const manifests = [manifest("email", [])];
    expect(bindingDeclarations(manifests, undefined)).toEqual(manifests);
  });
});

describe("resolveBindingNamings", () => {
  const manifests = [
    manifest("email", [{ type: "d1", name: "EMAIL_SUPPRESSIONS", scope: "global" }]),
    manifest("support", [{ type: "r2", name: "SUPPORT_BUCKET", scope: "global", resource: "support" }]),
    manifest("media", [{ type: "r2", name: "MEDIA_BUCKET", resource: "media" }]),
  ];
  const bindings = [
    { binding: "EMAIL_SUPPRESSIONS", kind: "d1" as const },
    { binding: "SUPPORT_BUCKET", kind: "r2" as const },
    { binding: "MEDIA_BUCKET", kind: "r2" as const },
  ];

  test("names each binding from what its manifest declares", () => {
    const namings = resolveBindingNamings({
      manifests,
      capabilities: new Set(["email", "support", "media"]),
      bindings,
      scope,
    });
    expect(namings.get("EMAIL_SUPPRESSIONS")).toEqual({
      capability: "email",
      naming: { scope: "global" },
      name: "acme-global-email-suppressions",
    });
    expect(namings.get("SUPPORT_BUCKET")?.name).toBe("acme-global-support");
    expect(namings.get("MEDIA_BUCKET")?.name).toBe("acme-staging-media");
  });

  test("reads nothing from a manifest no Worker composes", () => {
    const namings = resolveBindingNamings({ manifests, capabilities: new Set(["media"]), bindings, scope });
    expect([...namings.keys()]).toEqual(["MEDIA_BUCKET"]);
  });

  test("refuses two capabilities naming one binding's resource two ways", () => {
    expect(() =>
      resolveBindingNamings({
        manifests: [
          manifest("a", [{ type: "d1", name: "DB", scope: "global" }]),
          manifest("b", [{ type: "d1", name: "DB" }]),
        ],
        capabilities: new Set(["a", "b"]),
        bindings: [{ binding: "DB", kind: "d1" }],
        scope,
      }),
    ).toThrow(/Two capabilities disagree about the resource behind "DB"/);
  });

  test("refuses two bindings composing one resource name", () => {
    expect(() =>
      resolveBindingNamings({
        manifests: [
          manifest("a", [
            { type: "r2", name: "A_BUCKET", resource: "files" },
            { type: "r2", name: "B_BUCKET", resource: "files" },
          ]),
        ],
        capabilities: new Set(["a"]),
        bindings: [
          { binding: "A_BUCKET", kind: "r2" },
          { binding: "B_BUCKET", kind: "r2" },
        ],
        scope,
      }),
    ).toThrow(/both name acme-staging-files/);
  });
});
