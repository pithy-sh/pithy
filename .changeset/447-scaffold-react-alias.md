---
"@pithy-sh/cli": patch
"@pithy-sh/ui-react": patch
---

A scaffolded project resolves one React.

Nothing under `@pithy-sh/*` is published, so a kit is consumed from a sibling checkout by symlink — and Vite resolves a symlinked package from its realpath, so a kit package importing `react` gets the *kit checkout's* copy. Two copies of React is `invalid hook call` on every kit component the project mounts, and the stack blames the component rather than the resolution.

Two files ship the fix, and they need different mechanisms. The Worker's `vite.config.ts` gets `resolve.dedupe`, which works there because that config's root is the Worker directory, where React is installed. The project's `vitest.config.ts` gets an explicit alias, because `dedupe` resolves from the config's root — the repository root, which in a `pithy init` layout has no React at all. It finds nothing, changes nothing, and says nothing about it, which is the failure that is worst to debug.

Two alias rules per package, an exact one and a prefixed one, or `react-dom` is rewritten through the `react` entry.

A project scaffolded before this gets neither half from a re-run — `pithy init` does not run twice, and `pithy ui add` never overwrites an existing `vite.config.ts`. `docs/UI.md` § One React says which half you are missing and what to paste.

It is not a workaround for the symlink. It is what every linked-package setup needs, and it costs nothing once the kit is published.
