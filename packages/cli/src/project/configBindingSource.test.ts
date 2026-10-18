// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  addServiceBinding,
  declaredServiceBindings,
  removeServiceBinding,
  renderServiceBinding,
  retargetServiceBindings,
} from "./configBindingSource";

/** The shape `pithy worker add` scaffolds, trimmed to what the writer reads. */
const SCAFFOLDED = `import { defineCapability } from "@pithy-sh/core/src/capability/capability";

// A comment that mentions requiredBindings: [] and must be left alone.
const app = defineCapability({
  name: "appa",
  // Bindings this Worker's own routes need beyond what capabilities declare.
  requiredBindings: [],
  // routes: (a) => { a.get("/x", (c) => c.text("requiredBindings: [")); },
});

const config = {
  capabilities: [
    // pithy:capabilities (managed region — do not remove this marker)
  ],
  app,
};

export default config;
`;

const APP_B = { binding: "APP_B", target: "app-b" };

describe("renderServiceBinding", () => {
  test("is the declaration the issue names, verbatim", () => {
    expect(renderServiceBinding(APP_B)).toBe('{ type: "service", name: "APP_B", service: "app-b" }');
  });
});

describe("addServiceBinding", () => {
  test("fills an empty array and changes nothing else", () => {
    const after = addServiceBinding(SCAFFOLDED, APP_B);
    expect(after).toBe(
      SCAFFOLDED.replace(
        "  requiredBindings: [],\n",
        '  requiredBindings: [\n    { type: "service", name: "APP_B", service: "app-b" },\n  ],\n',
      ),
    );
  });

  test("appends after existing entries at their indentation, adding the comma the last one lacked", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      '  requiredBindings: [\n    { type: "d1", name: "DB" }\n  ],\n',
    );
    expect(addServiceBinding(source, APP_B)).toBe(
      SCAFFOLDED.replace(
        "  requiredBindings: [],\n",
        '  requiredBindings: [\n    { type: "d1", name: "DB" },\n    { type: "service", name: "APP_B", service: "app-b" },\n  ],\n',
      ),
    );
  });

  test("keeps a trailing comma and a comment after the last entry", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      '  requiredBindings: [\n    { type: "d1", name: "DB" }, // ours\n  ],\n',
    );
    expect(addServiceBinding(source, APP_B)).toBe(
      SCAFFOLDED.replace(
        "  requiredBindings: [],\n",
        '  requiredBindings: [\n    { type: "d1", name: "DB" }, // ours\n    { type: "service", name: "APP_B", service: "app-b" },\n  ],\n',
      ),
    );
  });

  test("a one-line array stays one line", () => {
    const source = SCAFFOLDED.replace("requiredBindings: [],", 'requiredBindings: [{ type: "d1", name: "DB" }],');
    expect(addServiceBinding(source, APP_B)).toBe(
      SCAFFOLDED.replace(
        "requiredBindings: [],",
        'requiredBindings: [{ type: "d1", name: "DB" }, { type: "service", name: "APP_B", service: "app-b" }],',
      ),
    );
  });

  test("a config whose app has no requiredBindings array it can find is null, never a guess", () => {
    expect(addServiceBinding("export default { capabilities: [], app };\n", APP_B)).toBeNull();
    const twice = `${SCAFFOLDED}\nconst other = defineCapability({ name: "x", requiredBindings: [] });\n`;
    expect(addServiceBinding(twice, APP_B)).toBe(
      twice.replace(
        "  requiredBindings: [],\n",
        '  requiredBindings: [\n    { type: "service", name: "APP_B", service: "app-b" },\n  ],\n',
      ),
    );
  });

  test("two candidates and no `const app` to choose between them is null", () => {
    const ambiguous =
      "const a = defineCapability({ requiredBindings: [] });\nconst b = defineCapability({ requiredBindings: [] });\n";
    expect(addServiceBinding(ambiguous, APP_B)).toBeNull();
  });
});

describe("removeServiceBinding", () => {
  test("takes the entry and its line out, by binding name", () => {
    const added = addServiceBinding(SCAFFOLDED, APP_B) as string;
    const withDb = added.replace("  requiredBindings: [\n", '  requiredBindings: [\n    { type: "d1", name: "DB" },\n');
    expect(removeServiceBinding(withDb, { binding: "APP_B" })).toBe(
      withDb.replace('    { type: "service", name: "APP_B", service: "app-b" },\n', ""),
    );
  });

  test("by target, with single quotes and the keys in another order", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      "  requiredBindings: [\n    { service: 'app-b', type: 'service', name: 'BEE' },\n    { type: \"d1\", name: \"DB\" },\n  ],\n",
    );
    expect(removeServiceBinding(source, { target: "app-b" })).toBe(
      source.replace("    { service: 'app-b', type: 'service', name: 'BEE' },\n", ""),
    );
  });

  test("the last entry of a one-line array leaves an empty one", () => {
    const source = SCAFFOLDED.replace(
      "requiredBindings: [],",
      'requiredBindings: [{ type: "d1", name: "DB" }, { type: "service", name: "APP_B", service: "app-b" }],',
    );
    expect(removeServiceBinding(source, { binding: "APP_B" })).toBe(
      SCAFFOLDED.replace("requiredBindings: [],", 'requiredBindings: [{ type: "d1", name: "DB" }],'),
    );
  });

  test("nothing matching is null", () => {
    expect(removeServiceBinding(SCAFFOLDED, { binding: "APP_B" })).toBeNull();
    const d1 = SCAFFOLDED.replace("requiredBindings: [],", 'requiredBindings: [{ type: "d1", name: "APP_B" }],');
    expect(removeServiceBinding(d1, { binding: "APP_B" })).toBeNull();
  });
});

describe("retargetServiceBindings", () => {
  test("rewrites every service entry naming the old Worker, and nothing else", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      '  requiredBindings: [\n    { type: "service", name: "APP_B", service: "app-b" },\n    { type: "service", name: "OTHER", service: "app-bb" },\n  ],\n',
    );
    expect(retargetServiceBindings(source, "app-b", "app-x")).toBe(
      source.replace('service: "app-b" }', 'service: "app-x" }'),
    );
  });

  test("takes every old name of the Worker, its deploy name included", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      '  requiredBindings: [\n    { type: "service", name: "BEE", service: "acme-app-b" },\n    { type: "service", name: "OTHER", service: "app-c" },\n  ],\n',
    );
    expect(retargetServiceBindings(source, ["app-b", "acme-app-b"], "app-x")).toBe(
      source.replace('service: "acme-app-b" }', 'service: "app-x" }'),
    );
  });

  test("a config with nothing to retarget is null", () => {
    expect(retargetServiceBindings(SCAFFOLDED, "app-b", "app-x")).toBeNull();
  });
});

describe("declaredServiceBindings", () => {
  test("reads each literal service entry, and skips every other kind", () => {
    const source = SCAFFOLDED.replace(
      "  requiredBindings: [],\n",
      '  requiredBindings: [\n    { type: "d1", name: "DB" },\n    { type: "service", name: "APP_B", service: "app-b" },\n  ],\n',
    );
    expect(declaredServiceBindings(source)).toEqual([{ binding: "APP_B", target: "app-b" }]);
    expect(declaredServiceBindings("export default {};\n")).toEqual([]);
  });
});
