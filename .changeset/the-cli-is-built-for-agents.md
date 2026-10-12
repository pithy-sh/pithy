---
"@pithy-sh/cli": minor
"@pithy-sh/core": minor
"@pithy-sh/email": minor
"@pithy-sh/i18n": minor
---

The CLI is built for agents now. It never prompts when told not to, describes every command with `pithy schema`, exits with a code that says what to do next, and plans before it changes anything. Failures exit 2 to 5 by kind, so test for non-zero, not 1.
