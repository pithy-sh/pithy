// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { capabilityImportSpecifier, findNamedImport, isCapabilityImport, withoutBinding } from "./configImports";

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

describe("isCapabilityImport", () => {
  const eject = "./capabilities/auth";

  test("accepts the barrel, any deeper path into the package, and the ejected copy", () => {
    expect(isCapabilityImport("@pithy-sh/auth/src/index", "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport("@pithy-sh/auth/src/capability", "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport("@pithy-sh/auth", "@pithy-sh/auth", eject)).toBe(true);
    expect(isCapabilityImport(eject, "@pithy-sh/auth", eject)).toBe(true);
  });

  test("rejects the adopter's own module and a shared-prefix package", () => {
    expect(isCapabilityImport("./lib/myAuth", "@pithy-sh/auth", eject)).toBe(false);
    expect(isCapabilityImport("@pithy-sh/authpro/src/index", "@pithy-sh/auth", eject)).toBe(false);
    expect(isCapabilityImport("./capabilities/authpro", "@pithy-sh/auth", eject)).toBe(false);
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

  test("takes the first name out without eating its neighbour's space", () => {
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
