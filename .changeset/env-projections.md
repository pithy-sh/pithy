---
"@pithy-sh/cli": patch
"@pithy-sh/ui-react-native": patch
"@pithy-sh/ui-react": patch
"@pithy-sh/ui-core": patch
"@pithy-sh/consent": patch
"@pithy-sh/vite": patch
---

A React Native app's web build uses the Turnstile sitekey of the environment it is built for, and the consent screens follow a custom consent base path on the web and on a phone.
