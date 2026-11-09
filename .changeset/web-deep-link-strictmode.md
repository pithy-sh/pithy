---
"@pithy-sh/ui-react-native": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/i18n": patch
---

An Expo app's web build opens a deep link on its own screen under pithy dev, not on Home. The screens under `<PithyLocale>` no longer remount when the catalog lands, in the React and the Expo app.
