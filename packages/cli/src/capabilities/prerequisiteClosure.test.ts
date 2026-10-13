// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { CapabilityManifest } from "@pithy-sh/core/src/capability/manifest";
import { describe, expect, test } from "vitest";
import { prerequisiteClosure } from "./prerequisiteClosure";

/** The real graph, in miniature: auth ⇒ secrets + email, email ⇒ secrets, secrets ⇒ nothing. */
const MANIFESTS = [
  { name: "auth", package: "@pithy-sh/auth", requiredBindings: [], peerCapabilities: ["secrets", "email"] },
  { name: "email", package: "@pithy-sh/email", requiredBindings: [], peerCapabilities: ["secrets"] },
  { name: "secrets", package: "@pithy-sh/secrets", requiredBindings: [] },
  { name: "audit", package: "@pithy-sh/audit", requiredBindings: [] },
].map((raw) => CapabilityManifest.parse(raw));

const byName = new Map(MANIFESTS.map((manifest) => [manifest.name, manifest]));
const manifestFor = (name: string): CapabilityManifest | undefined => byName.get(name);
const manifest = (name: string): CapabilityManifest => byName.get(name) as CapabilityManifest;

describe("prerequisiteClosure", () => {
  test("auth on a bare worker resolves secrets before email — deepest first, because email reads a secret", () => {
    // The order is the whole point. `pithy add email` on a worker with no secrets composed is the same
    // defect one capability along, so a plan that added email first would fix nothing.
    expect(prerequisiteClosure({ manifest: manifest("auth"), composed: new Set(), manifestFor })).toEqual([
      "secrets",
      "email",
    ]);
  });

  test("a peer already composed is not proposed again, and neither are its own peers", () => {
    expect(prerequisiteClosure({ manifest: manifest("auth"), composed: new Set(["email"]), manifestFor })).toEqual([
      "secrets",
    ]);
    expect(
      prerequisiteClosure({ manifest: manifest("auth"), composed: new Set(["secrets", "email"]), manifestFor }),
    ).toEqual([]);
  });

  test("a capability that declares no peers proposes nothing", () => {
    expect(prerequisiteClosure({ manifest: manifest("audit"), composed: new Set(), manifestFor })).toEqual([]);
  });

  test("declaration order does not decide dependency order — the graph does", () => {
    // Same graph, peers declared the other way round. A plan that merely echoed `peerCapabilities`
    // would compose email before the secrets it reads.
    const flipped = CapabilityManifest.parse({
      name: "auth",
      package: "@pithy-sh/auth",
      requiredBindings: [],
      peerCapabilities: ["email", "secrets"],
    });
    expect(prerequisiteClosure({ manifest: flipped, composed: new Set(), manifestFor })).toEqual(["secrets", "email"]);
  });

  test("a peer whose manifest is not installed yet is named as a leaf rather than dropped", () => {
    // Nothing can be known about a package that is not there. It is still missing, and saying so beats
    // silence — the recursive add resolves whatever it declares once it is installed.
    expect(
      prerequisiteClosure({ manifest: manifest("auth"), composed: new Set(), manifestFor: () => undefined }),
    ).toEqual(["secrets", "email"]);
  });

  test("a cycle terminates and names each capability once", () => {
    const cyclic = new Map(
      [
        { name: "a", package: "@pithy-sh/a", requiredBindings: [], peerCapabilities: ["b"] },
        { name: "b", package: "@pithy-sh/b", requiredBindings: [], peerCapabilities: ["a"] },
      ]
        .map((raw) => CapabilityManifest.parse(raw))
        .map((entry) => [entry.name, entry] as const),
    );
    expect(
      prerequisiteClosure({
        manifest: cyclic.get("a") as CapabilityManifest,
        composed: new Set(),
        manifestFor: (name) => cyclic.get(name),
      }),
    ).toEqual(["b"]);
  });
});
