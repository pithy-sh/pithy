// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import { capabilityImportSpecifier, findNamedImport, isCapabilityImport, withoutImport } from "./configImports";

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

describe("withoutImport", () => {
  test("takes the statement out with the line it sat on", () => {
    const source = 'import { auth } from "@pithy-sh/auth/src/index";\nexport default {};\n';
    const found = findNamedImport(source, "auth");
    expect(found && withoutImport(source, found)).toBe("export default {};\n");
  });

  test("takes a multi-line statement out whole", () => {
    const source = 'import {\n  auth,\n} from "@pithy-sh/auth/src/index";\nexport default {};\n';
    const found = findNamedImport(source, "auth");
    expect(found && withoutImport(source, found)).toBe("export default {};\n");
  });
});
