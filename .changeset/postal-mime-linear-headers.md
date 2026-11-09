---
"@pithy-sh/email": patch
"@pithy-sh/support": patch
---

Email's bounce handler and support's inbound parser run on postal-mime 4.0.8, and the bounce classifier matches a Message-ID within one line, so crafted mail no longer costs quadratic CPU.

Security: A message with a header of many RFC 2047 encoded words made email's bounce handler and support's inbound parser spend quadratic CPU, and a bounce body of unclosed Message-ID lines did the same to the bounce classifier, so anyone who could send the app mail could stall the Worker that received it.
