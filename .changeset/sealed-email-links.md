---
"@pithy-sh/email": minor
"@pithy-sh/core": patch
"@pithy-sh/ui-react": minor
"@pithy-sh/ui-react-native": minor
"@pithy-sh/testers": patch
"@pithy-sh/matchmaking": patch
---

Every tracked link email mints is now sealed, an unsubscribe link opens a page whose button opts out with any reason in the form body, and the code screen keeps the address out of its URL, so no request log learns who a link was for.

Security: The recipient's email address rode in every click, open and unsubscribe URL as decodable base64url, the recipient's opt-out reason in the unsubscribe query string, and the address in the OTP screen's query string, so each was written to the customer's request logs.
