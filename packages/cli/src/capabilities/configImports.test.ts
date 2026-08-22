// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  capabilityImportSpecifier,
  exportsName,
  findNamedImport,
  importOrigin,
  isCapabilityImport,
  namedReexports,
  withoutBinding,
} from "./configImports";

describe("capabilityImportSpecifier", () => {
  test("is the package's src/index barrel", () => {
    expect(capabilityImportSpecifier("@pithy-sh/secrets")).toBe("@pithy-sh/secrets/src/index");
  });
});

describe("findNamedImport", () => {
  test("finds the binding and reports where it comes from", () => {
    const found = findNamedImport('import { auth } from "@pithy-sh/auth/src/index";', "auth");
    expect(found?.specifier).toBe("@pithy-sh/auth/src/index");
    expect(found?.statement).toBe('import { auth } from "@pithy-sh/auth/src/index";');
  });

  test("reads either quote style and a multi-name clause", () => {
    expect(findNamedImport("import { a, auth, b } from './x';", "auth")?.specifier).toBe("./x");
  });

  test("tolerates indentation — cosmetic, not the absence of an import", () => {
    expect(findNamedImport('  import { auth } from "@pithy-sh/auth/src/index";', "auth")?.specifier).toBe(
      "@pithy-sh/auth/src/index",
    );
  });

  test("spans a multi-line clause", () => {
    expect(findNamedImport('import {\n  auth,\n} from "@pithy-sh/auth/src/index";', "auth")?.specifier).toBe(
      "@pithy-sh/auth/src/index",
    );
  });

  test("resolves an alias to the name it binds, not the one it re-exports", () => {
    expect(findNamedImport('import { auth as pithyAuth } from "@pithy-sh/auth/src/index";', "auth")).toBeUndefined();
    expect(findNamedImport('import { theirs as auth } from "./lib/auth";', "auth")?.specifier).toBe("./lib/auth");
  });

  test("ignores a type-only specifier — it binds no value a registration call could use", () => {
    expect(findNamedImport('import { type auth } from "@pithy-sh/auth/src/index";', "auth")).toBeUndefined();
    expect(findNamedImport('import type { auth } from "@pithy-sh/auth/src/index";', "auth")).toBeUndefined();
  });

  test("does not match a shared-prefix binding", () => {
    expect(findNamedImport('import { authpro } from "@pithy-sh/authpro/src/index";', "auth")).toBeUndefined();
  });

  test("returns nothing when the name is not imported", () => {
    expect(findNamedImport("export default { capabilities: [] };", "auth")).toBeUndefined();
  });

  test("does not read an import out of a block comment", () => {
    // The decoy that bit: a commented-out line above the real binding answered for it. `add` read the
    // capability as already wired and wrote nothing, leaving a config with no import and a call.
    const source = [
      "/*",
      ' import { auth } from "@pithy-sh/auth/src/index";',
      "*/",
      'import { auth } from "./lib/myAuth";',
    ].join("\n");
    expect(findNamedImport(source, "auth")?.specifier).toBe("./lib/myAuth");
  });

  test("does not read an import out of a template literal", () => {
    // A multi-line literal puts the decoy at the start of its own line, which is where the pattern looks.
    const source = ["const doc = `", 'import { auth } from "@pithy-sh/auth/src/index";', "`;"].join("\n");
    expect(findNamedImport(source, "auth")).toBeUndefined();
  });

  test("a block-comment opener inside a line comment opens nothing", () => {
    const source = ["// /* not a comment opener", 'import { auth } from "@pithy-sh/auth/src/index";'].join("\n");
    expect(findNamedImport(source, "auth")?.specifier).toBe("@pithy-sh/auth/src/index");
  });

  test("a comment inside the clause is not the absence of the binding", () => {
    const source = 'import { /* the capability */ auth } from "@pithy-sh/auth/src/index";';
    expect(findNamedImport(source, "auth")?.specifier).toBe("@pithy-sh/auth/src/index");
  });

  test("a comment opener inside a string does not blind the rest of the file", () => {
    const source = ['const note = "/*";', 'import { auth } from "@pithy-sh/auth/src/index";'].join("\n");
    expect(findNamedImport(source, "auth")?.specifier).toBe("@pithy-sh/auth/src/index");
  });
});

describe("importOrigin", () => {
  const eject = "./capabilities/auth";
  const origin = (specifier: string): string => importOrigin(specifier, "@pithy-sh/auth", eject);

  test("the barrel, any deeper path into the package, and the ejected copy are the capability", () => {
    expect(origin("@pithy-sh/auth/src/index")).toBe("capability");
    expect(origin("@pithy-sh/auth/src/capability")).toBe("capability");
    expect(origin(eject)).toBe("capability");
    expect(origin("./capabilities/auth/index")).toBe("capability");
  });

  test("the bare package is ours and resolves to nothing", () => {
    // No capability package declares a "." export — `catalog.test.ts` holds that claim against all
    // fifteen. So this import throws at load, and treating it as wiring made `add` bless a dead config.
    expect(origin("@pithy-sh/auth")).toBe("unresolvable");
  });

  test("a traversal past the package is not the package", () => {
    // The specifier is unresolved text, and Bun resolves `..` in it. A prefix test blessed anything the
    // adopter — or anything that wrote their config — could point past the package at.
    expect(origin("@pithy-sh/auth/../evil")).toBe("foreign");
    expect(origin("@pithy-sh/auth/src/../../../evil/mod")).toBe("foreign");
    expect(origin("./capabilities/auth/../../lib/evil")).toBe("foreign");
  });

  test("the adopter's own module and a shared-prefix package are foreign", () => {
    expect(origin("./lib/myAuth")).toBe("foreign");
    expect(origin("@pithy-sh/authpro/src/index")).toBe("foreign");
    expect(origin("./capabilities/authpro")).toBe("foreign");
  });
});

describe("isCapabilityImport", () => {
  const eject = "./capabilities/auth";

  test("is every origin but foreign — what is ours to rewrite or take out", () => {
    // Including the unresolvable bare package: it names our package, and leaving it behind while
    // `remove` uninstalls that package is the broken config the command exists to undo.
    expect(isCapabilityImport("@pithy-sh/auth/src/index", "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport("@pithy-sh/auth", "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport(eject, "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport("./lib/myAuth", "@pithy-sh/auth", eject)).toBe(false);
    expect(isCapabilityImport("@pithy-sh/auth/../evil", "@pithy-sh/auth", eject)).toBe(false);
  });
});

describe("withoutBinding", () => {
  /** Take `name`'s binding out of `source` — the two calls every caller makes, as one. */
  function without(source: string, name: string): string | undefined {
    const found = findNamedImport(source, name);
    return found && withoutBinding(source, found);
  }

  test("takes the statement out with the line it sat on when the name was all it bound", () => {
    expect(without('import { auth } from "@pithy-sh/auth/src/index";\nexport default {};\n', "auth")).toBe(
      "export default {};\n",
    );
  });

  test("takes a multi-line statement out whole", () => {
    expect(without('import {\n  auth,\n} from "@pithy-sh/auth/src/index";\nexport default {};\n', "auth")).toBe(
      "export default {};\n",
    );
  });

  test("takes only the binding out of a clause that binds more than one name", () => {
    // Deleting the statement took the adopter's other bindings with it and left a config that no longer
    // compiles — a removal that breaks the file it was cleaning up.
    expect(without('import { a, auth, b } from "@pithy-sh/auth/src/index";', "auth")).toBe(
      'import { a, b } from "@pithy-sh/auth/src/index";',
    );
  });

  test("takes the first name out without eating its neighbor's space", () => {
    expect(without('import { auth, b } from "@pithy-sh/auth/src/index";', "auth")).toBe(
      'import { b } from "@pithy-sh/auth/src/index";',
    );
  });

  test("keeps a multi-line clause's shape", () => {
    const source = 'import {\n  auth,\n  b,\n} from "@pithy-sh/auth/src/index";\n';
    expect(without(source, "auth")).toBe('import {\n  b,\n} from "@pithy-sh/auth/src/index";\n');
  });

  test("keeps a type-only sibling — it binds a name the config still references", () => {
    expect(without('import { auth, type AuthOptions } from "@pithy-sh/auth/src/index";', "auth")).toBe(
      'import { type AuthOptions } from "@pithy-sh/auth/src/index";',
    );
  });

  test("a trailing comma is not another name", () => {
    expect(without('import { auth, } from "@pithy-sh/auth/src/index";\nexport default {};\n', "auth")).toBe(
      "export default {};\n",
    );
  });
});

/**
 * **Is that name on this module at runtime?** — the question `pithy add` asks a Worker entry before
 * writing a Durable Object's export into it (#428), because a second statement exporting a name the
 * module already carries is a duplicate export the build refuses.
 *
 * Three spellings put a name on a module and two only look like it. The scanner draws the line, so a
 * commented-out export and a `verbatimModuleSyntax`-erased type answer the same way: no.
 */
describe("exportsName", () => {
  test("a re-export puts the name on the module", () => {
    expect(exportsName('export { Session } from "./session";', "Session")).toBe(true);
  });

  test("a bare clause over a local declaration does too", () => {
    expect(exportsName("class Session {}\nexport { Session };\n", "Session")).toBe(true);
  });

  test("so does a declaration exported where it is declared", () => {
    for (const source of [
      "export class Session {}",
      "export abstract class Session {}",
      "export const Session = 1;",
      "export async function Session() {}",
      "export function* Session() {}",
    ]) {
      expect(exportsName(source, "Session")).toBe(true);
    }
  });

  test("an alias binds the name it lands on, not the one it came from", () => {
    expect(exportsName('export { Room as Session } from "./room";', "Session")).toBe(true);
    expect(exportsName('export { Session as Room } from "./room";', "Session")).toBe(false);
  });

  test("a default export of the same name is not that name on the module", () => {
    // `export default class Session {}` puts `default` there and nothing else, so wrangler's `class_name`
    // still resolves to nothing.
    expect(exportsName("export default class Session {}", "Session")).toBe(false);
  });

  test("a type-only export is erased before it reaches the bundle", () => {
    expect(exportsName('export type { Session } from "./session";', "Session")).toBe(false);
    expect(exportsName('export { type Session } from "./session";', "Session")).toBe(false);
  });

  test("a commented-out export is not an export", () => {
    expect(exportsName('// export { Session } from "./session";', "Session")).toBe(false);
    expect(exportsName('/* export { Session } from "./session"; */', "Session")).toBe(false);
  });

  test("an export inside a string is a string", () => {
    expect(exportsName('const help = `export { Session } from "./session";`;', "Session")).toBe(false);
  });

  test("a longer name that merely starts the same is not it", () => {
    expect(exportsName('export { SessionStore } from "./session";', "Session")).toBe(false);
  });
});

/**
 * Every re-export and where it points — what `pithy add --eject` reads to move a fork's entry off the
 * package it has just copied.
 */
describe("namedReexports", () => {
  test("carries the statement, the specifier and the offset, in source order", () => {
    const source = [
      'import { createEntrypoint } from "@pithy-sh/core/src/createEntrypoint";',
      'export { Queue } from "@pithy-sh/matchmaking/src/queue/durableObject";',
      'export { Room } from "./rooms";',
    ].join("\n");
    // The offset is what an edit splices at. Found by searching for the statement instead, a caller
    // repointed the adopter's commented-out copy of a line — a comment contains the live statement
    // verbatim — and left the export that runs pointing at the package (#428).
    expect(namedReexports(source)).toEqual([
      {
        statement: 'export { Queue } from "@pithy-sh/matchmaking/src/queue/durableObject";',
        specifier: "@pithy-sh/matchmaking/src/queue/durableObject",
        start: source.indexOf("export { Queue }"),
      },
      { statement: 'export { Room } from "./rooms";', specifier: "./rooms", start: source.indexOf("export { Room }") },
    ]);
  });

  test("a clause with no from re-exports nothing, so it is not one", () => {
    expect(namedReexports("class Room {}\nexport { Room };\n")).toEqual([]);
  });

  test("a commented-out re-export points nowhere", () => {
    expect(namedReexports('// export { Room } from "./rooms";')).toEqual([]);
  });
});
