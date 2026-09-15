---
"@pithy-sh/cli": patch
---

The narration gate follows a relative `import()` written as a template literal, and refuses one built at runtime.

A command that reached a silent package-manager spawn through `` await import(`../dev/ports`) `` passed every narration test. The edge between modules read only quoted specifiers. A template literal with nothing interpolated is now the same edge. A relative specifier built from a literal, `` import(`../${name}`) `` or `import("../" + name)`, fails the build naming the file. An `import(spec)` through a variable is not seen, and `ci/childProcesses.ts` says so.

Two CLI gates the same work left red are green again: the credentialed-child exceptions no longer name two modules that stopped spawning, and `ci/childProcesses.test.ts` is registered as reading only its own package. No command's behavior changes.
