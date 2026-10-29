---
"@pithy-sh/ui-react": minor
"@pithy-sh/payments": minor
"@pithy-sh/i18n": minor
"@pithy-sh/cli": minor
---

Kit screens load data through `useRead` and run calls through `useAction` from `@pithy-sh/ui-core`, which `@pithy-sh/ui-react` re-exports for screens scaffolded before it, and a lint rule keeps raw `useEffect` out of kit code.
