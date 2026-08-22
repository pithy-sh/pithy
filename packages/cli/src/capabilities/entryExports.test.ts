// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { BindingSpec } from "@pithy-sh/core/src/capability/bindings";
import { describe, expect, test } from "vitest";
import { durableObjectExports, withDurableObjectExports, withoutDurableObjectExports } from "./entryExports";

/** The entry `pithy init` and `pithy worker add` both stamp, near enough to read the edits against. */
const ENTRY = `import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";
import config from "../pithy.config";

// The Worker.
export default createEntrypoint(config);
`;

const SESSION = { className: "MultiplayerSession", module: "@pithy-sh/multiplayer/src/session/durableObject" };
const QUEUE = { className: "MatchmakingQueue", module: "@pithy-sh/matchmaking/src/queue/durableObject" };

/** The binding a capability declares for one of those classes — the shape both halves are derived from. */
function binding(name: string, exported: { className: string; module: string }) {
  return BindingSpec.parse({
    type: "durable_object",
    name,
    className: exported.className,
    classModule: exported.module,
  });
}

describe("durableObjectExports", () => {
  test("takes the Durable Object bindings and nothing else", () => {
    const bindings = [
      BindingSpec.parse({ type: "d1", name: "DB" }),
      // A workflow binding carries a `className` too, and its class lives in the capability's own host
      // Worker — never in the adopter's entry. Reading the field instead of the kind would export a
      // `WorkflowEntrypoint` from a module the adopter's Worker does not run.
      BindingSpec.parse({ type: "workflow", name: "EMAIL_SENDER", job: "send", className: "EmailSendWorkflow" }),
      binding("SESSIONS", SESSION),
    ];
    expect(durableObjectExports(bindings)).toEqual([SESSION]);
  });

  test("names one class once, however many bindings share it", () => {
    const bindings = [binding("SESSIONS", SESSION), binding("TABLES", SESSION)];
    expect(durableObjectExports(bindings)).toEqual([SESSION]);
  });
});

describe("withDurableObjectExports", () => {
  test("writes the statement wrangler resolves class_name against", () => {
    const written = withDurableObjectExports(ENTRY, [SESSION]);
    expect(written).toContain('export { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";');
    // The entry it was given is still there, untouched, ahead of the addition.
    expect(written.startsWith(ENTRY)).toBe(true);
  });

  test("running it twice changes nothing", () => {
    const once = withDurableObjectExports(ENTRY, [SESSION]);
    expect(withDurableObjectExports(once, [SESSION])).toBe(once);
  });

  test("a second capability's class joins the block, under the one note", () => {
    const both = withDurableObjectExports(withDurableObjectExports(ENTRY, [SESSION]), [QUEUE]);
    expect(both).toContain('export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";');
    expect(both.match(/Durable Object classes/g)).toHaveLength(1);
  });

  test("nothing to write leaves the source identical", () => {
    expect(withDurableObjectExports(ENTRY, [])).toBe(ENTRY);
  });

  test("an export the adopter wrote by hand is left as it is", () => {
    // Whoever wrote it, the class is on the module — which is the whole of what wrangler asks. A second
    // statement exporting the same name is a duplicate export, and the build refuses it.
    const hand = `${ENTRY}\nexport { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";\n`;
    expect(withDurableObjectExports(hand, [SESSION])).toBe(hand);
  });

  test("an aliased export of somebody else's class is not this one", () => {
    // `export { Session as MultiplayerSession }` binds the name, so wrangler resolves it. `export
    // { MultiplayerSession as Session }` does not — it puts `Session` on the module and nothing else.
    const aliasedTo = `${ENTRY}\nexport { Session as MultiplayerSession } from "./mine";\n`;
    expect(withDurableObjectExports(aliasedTo, [SESSION])).toBe(aliasedTo);
    const aliasedAway = `${ENTRY}\nexport { MultiplayerSession as Session } from "./mine";\n`;
    expect(withDurableObjectExports(aliasedAway, [SESSION])).toContain(
      'export { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";',
    );
  });

  test("a commented-out export is not an export", () => {
    // Structural, through the same scanner `pithy add` reads a config's imports with. A line somebody
    // commented out while debugging is not a class on the module, and a deploy would say so.
    const commented = `${ENTRY}\n// export { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";\n`;
    expect(withDurableObjectExports(commented, [SESSION])).toContain(
      '\nexport { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";',
    );
  });

  test("a class the adopter declared and exported in the entry is left alone", () => {
    // The claim is "a class already on the module is left alone, whoever put it there", and a class
    // declared where it is exported is on the module exactly as a re-export is. Appending ours beside it
    // is `SyntaxError: Duplicate export of 'MultiplayerSession'` — a build that stops before wrangler is
    // ever asked, which is worse than the deploy failure this whole file exists to prevent.
    const declared = `${ENTRY}\nexport class MultiplayerSession {}\n`;
    expect(withDurableObjectExports(declared, [SESSION])).toBe(declared);
  });

  test("a class exported by a bare clause after its declaration is left alone", () => {
    // The other spelling of the same fact. `export { X }` with no `from` re-exports nothing, so it is not
    // a line we would ever write — but it does put `X` on the module, which is the only question here.
    const bare = `${ENTRY}\nclass MultiplayerSession {}\nexport { MultiplayerSession };\n`;
    expect(withDurableObjectExports(bare, [SESSION])).toBe(bare);
  });

  test("a default-exported class of the same name is not that name on the module", () => {
    // `export default class MultiplayerSession {}` puts `default` on the module and nothing else, so
    // wrangler's `class_name` still resolves to nothing. The export is written.
    const dflt = `${ENTRY}\nexport default class MultiplayerSession {}\n`;
    expect(withDurableObjectExports(dflt, [SESSION])).toContain(
      '\nexport { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";',
    );
  });

  test("a type-only export is not an export", () => {
    // `verbatimModuleSyntax` erases it, so the emitted module carries no class and wrangler's
    // `class_name` resolves to nothing — #426's fact, one export keyword over.
    const typed = `${ENTRY}\nexport type { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";\n`;
    const written = withDurableObjectExports(typed, [SESSION]);
    expect(written).toContain(
      '\nexport { MultiplayerSession } from "@pithy-sh/multiplayer/src/session/durableObject";',
    );
  });
});

describe("withoutDurableObjectExports", () => {
  /**
   * The caller's rule for "this specifier is the capability's", stood in for here. `pithy remove` answers
   * it with `isCapabilityImport`, which accepts the package **and** the ejected fork path; these two
   * modules are what the fixtures above export from.
   */
  const ours = (specifier: string) => specifier === SESSION.module || specifier === QUEUE.module;

  test("restores the entry byte for byte — the clean inverse of add", () => {
    expect(withoutDurableObjectExports(withDurableObjectExports(ENTRY, [SESSION]), [SESSION], ours)).toBe(ENTRY);
  });

  test("a sibling capability's class stays, and keeps the note it needs", () => {
    const both = withDurableObjectExports(withDurableObjectExports(ENTRY, [SESSION]), [QUEUE]);
    const rest = withoutDurableObjectExports(both, [SESSION], ours);
    expect(rest).not.toContain("MultiplayerSession");
    expect(rest).toContain('export { MatchmakingQueue } from "@pithy-sh/matchmaking/src/queue/durableObject";');
    expect(rest).toContain("Durable Object classes");
  });

  test("an export of the same class from the adopter's own module is not ours to take out", () => {
    // The rule `remove` reads an import by: the name identifies it, the specifier decides what to do
    // about it. A class they re-export from their own fork stays with them.
    const mine = `${ENTRY}\nexport { MultiplayerSession } from "./session";\n`;
    expect(withoutDurableObjectExports(mine, [SESSION], ours)).toBe(mine);
  });

  test("the note goes when the line under it is the adopter's, not another class", () => {
    // The block is appended at the end of the entry, and multiplayer's own scaffold step tells the
    // adopter to call `registerGameModel(myGame)` there — so a line written under the block is the
    // expected case, not the odd one. Left standing, the note describes code it has nothing to do with,
    // and the round trip this function promises is not byte-identical after all.
    const written = `${withDurableObjectExports(ENTRY, [SESSION])}registerGameModel(myGame);\n`;
    const rest = withoutDurableObjectExports(written, [SESSION], ours);
    expect(rest).not.toContain("Durable Object classes");
    expect(rest).toContain("registerGameModel(myGame);");
  });

  test("a blank line under the emptied note is still nothing under it", () => {
    const written = `${withDurableObjectExports(ENTRY, [SESSION])}\nregisterGameModel(myGame);\n`;
    expect(withoutDurableObjectExports(written, [SESSION], ours)).not.toContain("Durable Object classes");
  });

  test("an entry that never had the export is returned unchanged", () => {
    expect(withoutDurableObjectExports(ENTRY, [SESSION], ours)).toBe(ENTRY);
  });
});
