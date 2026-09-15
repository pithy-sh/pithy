---
"@pithy-sh/email": patch
"@pithy-sh/media": patch
"@pithy-sh/storage": patch
---

A setting with a closed set of values offers them.

`email`'s `theme` and `devDelivery`, `media`'s `recordStore` and `storage`'s `defaultVisibility` are each a `z.enum` in the capability's config and were free text at `pithy add`. Nothing declared the values, so nothing could offer them: the prompt asked for a string, `--set devDelivery=simulater` wrote the typo into `pithy.config.ts`, and the capability refused to load at the next command that read it. All four declare their values now, and a gate holds every manifest option to the enum behind it.
