# @pithy-sh/ui-react-native

## 0.2.1

### Patch Changes

- [#943](https://github.com/pithy-sh/pithy/pull/943) [`db748ff`](https://github.com/pithy-sh/pithy/commit/db748ffd2ee815440be40dc57c09ee8ff0dd8abf) Thanks [@kingmesal](https://github.com/kingmesal)! - A new React Native app's `app.config.ts` now loads under Expo 57, so `pithy dev` starts it beside the Workers.

- [#945](https://github.com/pithy-sh/pithy/pull/945) [`f8d03e6`](https://github.com/pithy-sh/pithy/commit/f8d03e613dc637c948a2ca81f42d5d874645e4d5) Thanks [@kingmesal](https://github.com/kingmesal)! - A new React Native app's `tsconfig.json` keeps its comments when Expo starts, so the first `pithy dev` leaves the file as scaffolded.

- [#950](https://github.com/pithy-sh/pithy/pull/950) [`1269f29`](https://github.com/pithy-sh/pithy/commit/1269f2909007f68e35bc99fb26a5f6b7a00cdf05) Thanks [@kingmesal](https://github.com/kingmesal)! - Test your app's screens without a device: `pithy init --react-native` now scaffolds a Vitest project on the kit's native-module stand-ins, published as `@pithy-sh/ui-react-native/testing`.

## 0.2.0

### Minor Changes

- [#939](https://github.com/pithy-sh/pithy/pull/939) [`c286341`](https://github.com/pithy-sh/pithy/commit/c28634177e572427971b44afde974c5ebdb27ac1) Thanks [@kingmesal](https://github.com/kingmesal)! - Every tracked link email mints is now sealed, an unsubscribe link opens a page whose button opts out with any reason in the form body, and the code screen keeps the address out of its URL, so no request log learns who a link was for.
  
  Security: The recipient's email address rode in every click, open and unsubscribe URL as decodable base64url, the recipient's opt-out reason in the unsubscribe query string, and the address in the OTP screen's query string, so each was written to the customer's request logs.

## 0.1.0

### Minor Changes

- [#879](https://github.com/pithy-sh/pithy/pull/879) [`3bf6b34`](https://github.com/pithy-sh/pithy/commit/3bf6b3483ee1f6cbf1b8e9cd96f57a557b336ca1) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add react-native` gives an Expo app the kit's screens, session and checkout on iOS, Android and the web, from one codebase.

### Patch Changes

- [#889](https://github.com/pithy-sh/pithy/pull/889) [`da603f4`](https://github.com/pithy-sh/pithy/commit/da603f47a0a96c4c7b8eaba2528c95021e6f9cef) Thanks [@kingmesal](https://github.com/kingmesal)! - A React Native app's web build uses the Turnstile sitekey of the environment it is built for, and the consent screens follow a custom consent base path on the web and on a phone.
