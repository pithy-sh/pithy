# @pithy-sh/ui-react-native

## 0.2.0

### Minor Changes

- [#939](https://github.com/pithy-sh/pithy/pull/939) [`c286341`](https://github.com/pithy-sh/pithy/commit/c28634177e572427971b44afde974c5ebdb27ac1) Thanks [@kingmesal](https://github.com/kingmesal)! - Every tracked link email mints is now sealed, an unsubscribe link opens a page whose button opts out with any reason in the form body, and the code screen keeps the address out of its URL, so no request log learns who a link was for.
  
  Security: The recipient's email address rode in every click, open and unsubscribe URL as decodable base64url, the recipient's opt-out reason in the unsubscribe query string, and the address in the OTP screen's query string, so each was written to the customer's request logs.

## 0.1.0

### Minor Changes

- [#879](https://github.com/pithy-sh/pithy/pull/879) [`3bf6b34`](https://github.com/pithy-sh/pithy/commit/3bf6b3483ee1f6cbf1b8e9cd96f57a557b336ca1) Thanks [@kingmesal](https://github.com/kingmesal)! - `pithy ui add react-native` gives an Expo app the kit's screens, session and checkout on iOS, Android and the web, from one codebase.

### Patch Changes

- [#889](https://github.com/pithy-sh/pithy/pull/889) [`da603f4`](https://github.com/pithy-sh/pithy/commit/da603f47a0a96c4c7b8eaba2528c95021e6f9cef) Thanks [@kingmesal](https://github.com/kingmesal)! - A React Native app's web build uses the Turnstile sitekey of the environment it is built for, and the consent screens follow a custom consent base path on the web and on a phone.
