// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { callsGate, gateCallSites, withoutComments } from "./gateScan";

const gated = `
import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";
export const routes = (app) => app.get("/reports", requireEntitlement("pro"), (c) => c.json({}));
`;

describe("deciding whether one source gates", () => {
  test("a call to requireEntitlement gates", () => {
    expect(callsGate(gated)).toBe(true);
  });

  test("requireAnyEntitlement counts too", () => {
    expect(callsGate(`app.get("/x", requireAnyEntitlement(["pro", "lifetime"]), handler);`)).toBe(true);
  });

  test("a call split across lines still gates", () => {
    expect(callsGate('requireEntitlement\n  ("pro")')).toBe(true);
  });

  test("source with no gate does not gate", () => {
    expect(callsGate(`app.get("/free", (c) => c.json({}));`)).toBe(false);
  });

  test("an import of the gate is not a gate", () => {
    // Only a call gates a route. Importing the helper and never using it is not a composition error,
    // and reporting it would make the check noise a reader learns to ignore.
    expect(callsGate(`import { requireEntitlement } from "@pithy-sh/core/src/entitlement/require";\n`)).toBe(false);
  });

  test("a longer identifier ending in the gate's name is not a gate", () => {
    expect(callsGate("myRequireEntitlement(key)")).toBe(false);
  });

  test("a mention in a line comment is not a gate", () => {
    expect(callsGate(`// TODO: put requireEntitlement("pro") here once payments lands.\napp.get("/x", h);`)).toBe(
      false,
    );
  });

  test("a gate inside a block comment is not a gate", () => {
    expect(callsGate(`/* app.get("/x", requireEntitlement("pro"), h) */\napp.get("/free", h);`)).toBe(false);
  });

  test("a `/*` inside a string does not blind the scan", () => {
    // The defect this pins: blanking block comments with a regex over raw source lets a `/*` inside a
    // string literal open a comment that swallows everything to the next `*/`. A route path like
    // `/assets/*` followed by any doc comment hides the gate between them, and the check reports clean.
    const source = [
      'app.get("/assets/*", serveAssets);',
      'app.get("/reports", requireEntitlement("pro"), handler);',
      "/** A doc comment, whose opening the string above must not have already consumed. */",
    ].join("\n");
    expect(callsGate(source)).toBe(true);
  });

  test("a URL's `//` does not start a comment", () => {
    const source = ['const docs = "https://pithy.sh/payments";', 'app.get("/x", requireEntitlement("pro"), h);'].join(
      "\n",
    );
    expect(callsGate(source)).toBe(true);
  });
});

describe("blanking comments", () => {
  test("offsets and lines survive, so anything reported against the text lines up with the file", () => {
    const source = 'const a = 1; // note\nconst b = "keep";\n/* two\nlines */\n';
    const blanked = withoutComments(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
    expect(blanked).toContain('const b = "keep";');
    expect(blanked).not.toContain("note");
  });

  test("an unterminated block comment blanks to the end rather than throwing", () => {
    expect(withoutComments("code;\n/* unterminated").trimEnd()).toBe("code;");
  });

  test("an unterminated quoted string ends at its newline, so the next line is still code", () => {
    // Without this, one stray quote would swallow the rest of the file and hide every gate below it.
    expect(callsGate('const broken = "oops;\nrequireEntitlement("pro");')).toBe(true);
  });
});

describe("gate call sites across a set of sources", () => {
  test("names the gating files, sorted, so a failure reads as a set", () => {
    expect(
      gateCallSites({
        "src/b.ts": `requireEntitlement("pro"); requireEntitlement("team");`,
        "src/a.tsx": `requireEntitlement("pro")`,
        "src/free.ts": `app.get("/free", h);`,
      }),
    ).toEqual(["src/a.tsx", "src/b.ts"]);
  });

  test("no sources is no findings", () => {
    expect(gateCallSites({})).toEqual([]);
  });
});
