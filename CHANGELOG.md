# Changelog

## [0.1.0]

First release.

- Sign-in and sign-out with the tokens sealed in an httpOnly cookie, refreshed
  by the proxy and by `getAccessToken()`.
- `auth()`, `requireSession()` and `getAccessToken()` on the server;
  `useAuth()`, `<SignedIn>` and `<SignedOut>` in the browser.
- The User API: the user's profile, email, sessions, connected apps and
  passkeys, from the server or the browser.
- `addPasskey()`, and `prompt: "login"` and `maxAge` for a fresh sign-in.
- `<AuthallaProvider session>` takes the promise from `clientSession()`, so
  the root layout doesn't block prerendering with Cache Components.
