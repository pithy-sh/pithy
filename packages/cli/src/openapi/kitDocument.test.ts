// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { undescribedAsyncFields } from "@pithy-sh/core/src/asyncapi/document";
import { undescribedFields, undescribedRoutes } from "@pithy-sh/core/src/openapi/document";
import { describe, expect, test } from "vitest";
import { CATALOG } from "../capabilities/catalog";
import {
  KIT_COMPOSITION,
  KIT_CONTRACT_PATH,
  KIT_SOCKET_CONTRACT_PATH,
  kitComposition,
  kitDocument,
  kitSocketDocument,
  kitSocketGroups,
} from "./kitDocument";
import { operationCount, renderDocument } from "./workerContract";

/**
 * **The kit's published document covers the whole kit, describes all of it, and is current (#719).**
 *
 * Composed once for the file: assembling twenty capabilities is the expensive part, and every assertion
 * here reads the same assembly.
 */

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

const composed = kitComposition();
const groups = composed.groups;
const document = kitDocument(groups);
const sockets = kitSocketDocument(kitSocketGroups(composed.capabilities));

/**
 * The capabilities that mount no route of their own, and what they contribute instead. Named, so the
 * tag check below is exact: a capability that grows a route is a tag the document must carry, and one that
 * loses every route is a deliberate edit here.
 */
const ROUTELESS: Readonly<Record<string, string>> = {
  i18n: "A translator and locale negotiation, as middleware.",
  turnstile: "A humanity check stacked on other capabilities' routes.",
};

describe("the kit's OpenAPI document", () => {
  test("every cataloged capability has a row in the composition", () => {
    const missing = CATALOG.map((entry) => entry.name).filter((name) => !(name in KIT_COMPOSITION));
    expect(
      missing,
      `These capabilities are in CATALOG and not in KIT_COMPOSITION, so the kit's document omits their routes: ${missing.join(", ")}. Add a row to KIT_COMPOSITION in src/openapi/kitDocument.ts with a config that mounts every route the capability has.`,
    ).toEqual([]);
    // And no row for something the catalog does not ship, which would document routes no adopter can add.
    expect(Object.keys(KIT_COMPOSITION).sort()).toEqual(CATALOG.map((entry) => entry.name).sort());
    expect(KIT_COMPOSITION).toHaveProperty("controlplane");
  });

  test("every route the kit mounts is described", () => {
    expect(
      undescribedRoutes(groups),
      "A kit route has no describeRoute, so the published document leaves it out. Describe it beside its validators.",
    ).toEqual([]);
  });

  test("every field and parameter in the document carries a description", () => {
    expect(undescribedFields(document)).toEqual([]);
  });

  test("the committed document is the rendered one", () => {
    const committed = readFileSync(join(REPO_ROOT, KIT_CONTRACT_PATH), "utf8");
    // Compared as text, and only the verdict reported: the document is over a megabyte, and a diff of it
    // is not a message anyone reads.
    expect(committed === renderDocument(document), `${KIT_CONTRACT_PATH} is stale. Run \`bun run kit-contract\`.`).toBe(
      true,
    );
  });

  test("every operationId is unique", () => {
    const ids = Object.values(document.paths).flatMap((item) =>
      Object.values(item).map((operation) => (operation as { operationId?: unknown }).operationId),
    );
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(repeated, "Two operations share an operationId, so a generated client gets one method for both.").toEqual(
      [],
    );
    expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  });

  test("the document is not vacuous: it holds the kit's routes, under every capability's tag", () => {
    // A floor rather than the count, which moves with every route a capability adds. 174 when written.
    expect(operationCount(document)).toBeGreaterThanOrEqual(170);
    const expected = ["core", ...Object.keys(KIT_COMPOSITION).filter((name) => !(name in ROUTELESS))].sort();
    expect(document.tags.map((tag) => tag.name).sort()).toEqual(expected);
    for (const name of Object.keys(ROUTELESS)) {
      expect(groups.find((group) => group.tag === name)?.routes, name).toEqual([]);
    }
  });
});

/**
 * **And its socket document (#718).** The same three properties over the sockets: the kit's two socket
 * capabilities are in it, every frame field is described, and the committed file is current.
 */
describe("the kit's AsyncAPI document", () => {
  test("describes the room socket and the presence socket, and the built-in games' schemas", () => {
    const tags = Object.values(sockets.channels).flatMap((channel) =>
      (channel.tags as { name: string }[]).map((tag) => tag.name),
    );
    expect([...new Set(tags)].sort()).toEqual(["matchmaking", "multiplayer"]);
    const schemas = Object.keys(sockets.components.schemas);
    // Keyed by the configured game, not its model: an adopter may run one model under two keys.
    for (const game of ["battle", "connect-four", "craps-table"]) {
      expect(
        schemas.some((name) => name.endsWith(`.${game}.action`)),
        `${game}.action`,
      ).toBe(true);
      expect(
        schemas.some((name) => name.endsWith(`.${game}.view`)),
        `${game}.view`,
      ).toBe(true);
    }
  });

  test("every frame field and channel parameter carries a description", () => {
    expect(undescribedAsyncFields(sockets)).toEqual([]);
  });

  test("the committed document is the rendered one", () => {
    const committed = readFileSync(join(REPO_ROOT, KIT_SOCKET_CONTRACT_PATH), "utf8");
    expect(
      committed === renderDocument(sockets),
      `${KIT_SOCKET_CONTRACT_PATH} is stale. Run \`bun run kit-contract\`.`,
    ).toBe(true);
  });
});
