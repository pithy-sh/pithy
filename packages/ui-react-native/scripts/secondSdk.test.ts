// SPDX-FileCopyrightText: 2026 Pithy
// SPDX-License-Identifier: MIT

import { describe, expect, test } from "vitest";
import {
  sdkPackageNames,
  secondSdkPaths,
  secondSdkTsconfig,
  secondSdkVersions,
  typesEntry,
  unmappedPackages,
} from "./secondSdk";

describe("sdkPackageNames", () => {
  const peers: Record<string, Record<string, string>> = {
    "expo-router": { expo: "*", react: "*" },
    "react-native-webview": { react: "*", "react-native": "*" },
    "@testing-library/react": { react: "^19" },
    "react-native-web": { react: "*", "react-dom": "*" },
    "@pithy-sh/i18n": { react: "*", "react-native": "*" },
  };
  const names = sdkPackageNames(
    {
      expo: "57.0.31",
      react: "^19.2.8",
      "react-native": "0.86.3",
      "@types/react": "^19.2.17",
      "expo-router": "57.0.29",
      "react-native-webview": "13.16.1",
      "@testing-library/react": "16.3.3",
      "react-native-web": "0.21.4",
      "@pithy-sh/i18n": "workspace:*",
      zod: "^4.4.0",
    },
    (name) => peers[name],
  );

  test("takes React, React Native, their types and Expo", () => {
    expect(names).toEqual(expect.arrayContaining(["expo", "react", "react-native", "@types/react"]));
  });

  test("takes every package that builds on React Native or Expo", () => {
    expect(names).toEqual(expect.arrayContaining(["expo-router", "react-native-webview"]));
  });

  test("leaves out the test tooling, the web build and the kit's own packages", () => {
    for (const name of ["@testing-library/react", "react-native-web", "@pithy-sh/i18n", "zod"]) {
      expect(names).not.toContain(name);
    }
  });

  test("answers in a stable order", () => {
    expect(names).toEqual([...names].sort());
  });
});

describe("secondSdkVersions", () => {
  const versions = secondSdkVersions({
    names: ["expo", "react", "@types/react", "expo-router", "@expo/app-integrity", "expo-iap"],
    pins: {
      expo: "57.0.31",
      react: "^19.2.8",
      "@types/react": "^19.2.17",
      "expo-router": "57.0.29",
      "@expo/app-integrity": "57.0.2",
      "expo-iap": "6.3.0",
    },
    currentExpo: "57.0.31",
    expo: { version: "58.0.26", devDependencies: { "@types/react": "~19.3.0" } },
    bundled: { react: "19.3.0", "expo-router": "~58.0.32" },
  });

  test("Expo is the release installed", () => {
    expect(versions.expo).toBe("58.0.26");
  });

  test("a package Expo bundles takes Expo's version, as `expo install` does", () => {
    expect(versions.react).toBe("19.3.0");
    expect(versions["expo-router"]).toBe("~58.0.32");
  });

  test("a package Expo itself depends on takes Expo's range", () => {
    expect(versions["@types/react"]).toBe("~19.3.0");
  });

  test("a package versioned with the SDK moves to the SDK's major", () => {
    expect(versions["@expo/app-integrity"]).toBe("~58.0.0");
  });

  test("a package outside the SDK keeps the workspace's pin", () => {
    expect(versions["expo-iap"]).toBe("6.3.0");
  });
});

describe("typesEntry", () => {
  test("follows the types condition through nested conditions", () => {
    expect(
      typesEntry({
        exports: {
          ".": { types: { "expo-source": "./src/index.tsx", default: "./build/index.d.ts" }, default: "./x.js" },
        },
      }),
    ).toBe("./build/index.d.ts");
  });

  test("skips a condition the templates' program does not set", () => {
    expect(
      typesEntry({
        exports: {
          ".": {
            "react-native-legacy-deep-imports": "./types_DEPRECATED/index.d.ts",
            types: "./types_generated/index.d.ts",
            default: "./index.js",
          },
        },
      }),
    ).toBe("./types_generated/index.d.ts");
  });

  test("skips a versioned types condition for an older TypeScript", () => {
    expect(
      typesEntry({
        exports: { ".": { "types@<=5.0": { default: "./ts5.0/index.d.ts" }, types: { default: "./index.d.ts" } } },
      }),
    ).toBe("./index.d.ts");
  });

  test("falls back to the types field when exports name no declarations", () => {
    expect(typesEntry({ types: "build/Crypto.d.ts", exports: { ".": "./build/Crypto.js" } })).toBe("build/Crypto.d.ts");
  });

  test("reads exports written as one condition map, with no subpaths", () => {
    expect(typesEntry({ exports: { types: "./index.d.ts", default: "./index.js" } })).toBe("./index.d.ts");
  });

  test("answers undefined for a package with no declarations", () => {
    expect(typesEntry({ main: "index.js" })).toBeUndefined();
  });
});

describe("secondSdkPaths", () => {
  const paths = secondSdkPaths("/sdk", [
    { name: "react", manifest: { main: "index.js" } },
    { name: "@types/react", manifest: { types: "index.d.ts" } },
    { name: "react-native", manifest: { exports: { ".": { types: "./types_generated/index.d.ts" } } } },
  ]);

  test("points each package and its subpaths at the second SDK's copy", () => {
    expect(paths["react-native"]).toEqual(["/sdk/node_modules/react-native/types_generated/index.d.ts"]);
    expect(paths["react-native/*"]).toEqual(["/sdk/node_modules/react-native/*"]);
  });

  test("a runtime package with no declarations takes its @types package", () => {
    expect(paths.react).toEqual(["/sdk/node_modules/@types/react/index.d.ts"]);
    expect(paths["react/*"]).toEqual(["/sdk/node_modules/@types/react/*"]);
  });
});

describe("unmappedPackages", () => {
  test("answers nothing when every package resolves to the second SDK, through its own types or its @types", () => {
    const installed = [
      { name: "react", manifest: { main: "index.js" } },
      { name: "@types/react", manifest: { types: "index.d.ts" } },
      { name: "expo", manifest: { types: "build/index.d.ts" } },
    ];
    expect(unmappedPackages(installed, secondSdkPaths("/sdk", installed))).toEqual([]);
  });

  test("names a package whose declarations sit under a condition the program does not read", () => {
    const installed = [
      { name: "expo", manifest: { types: "build/index.d.ts" } },
      { name: "react-native", manifest: { exports: { ".": { "react-native-strict-api": "./types/index.d.ts" } } } },
    ];
    expect(unmappedPackages(installed, secondSdkPaths("/sdk", installed))).toEqual(["react-native"]);
  });

  test("names a package that ships declarations only as an implicit index.d.ts", () => {
    const installed = [{ name: "expo-crypto", manifest: { main: "index.js" } }];
    expect(unmappedPackages(installed, secondSdkPaths("/sdk", installed))).toEqual(["expo-crypto"]);
  });

  test("names an @types package that ships no declarations", () => {
    expect(unmappedPackages([{ name: "@types/react" }], {})).toEqual(["@types/react"]);
  });
});

describe("secondSdkTsconfig", () => {
  test("is the templates' own program with module paths into the second SDK", () => {
    expect(secondSdkTsconfig("/kit/tsconfig.templates.json", { react: ["/sdk/r.d.ts"] })).toEqual({
      extends: "/kit/tsconfig.templates.json",
      compilerOptions: { paths: { react: ["/sdk/r.d.ts"] } },
    });
  });
});
