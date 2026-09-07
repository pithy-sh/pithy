---
"@pithy-sh/cli": patch
"@pithy-sh/core": patch
---

A refusal never offers a value the next refusal rejects.

Making `billingSubject=organization` unwritable left the message telling you what to pass still naming it: `pithy add payments --json` answered `Pass --set billingSubject=user or --set billingSubject=organization`, and passing the second was refused. The interactive prompt had the same gap, offering it in the select.

Both now offer only what composes. The prompt withholds such a choice rather than listing something unselectable, and says what it would take — `organization` is the mode a B2B project is looking for, and a list that simply lacks it reads as "unsupported" instead of "needs one line you have to write".

The rule, written down in `docs/commands/add.md`: **a scaffolded stub is right when the missing value is data, and a refusal is right when it is behavior.** `pithy add secrets` writes an empty registry with a comment, because an empty registry is a valid state you fill in; there is no equivalent for `resolveSubject`, because a resolver returning nothing loads and then silently denies every entitlement gate.
