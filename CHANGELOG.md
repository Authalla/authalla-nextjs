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
- `signInUrl()` and a server `signOut()` for Server Components and Server
  Actions.
- `useAuth({ suspense: true })`, so a component waits for the session
  instead of rendering a loading state first.
- `requireSession()` comes back to the current page by default.
- `user.picture`, the user's profile picture from a social login.
- `auth()` refreshes an expiring access token in Server Actions and Route
  Handlers, so a revoked session is signed out there too.
- The `/me` route forwards only plain paths, answers with `nosniff` and a
  CSP, and refuses request bodies over 64 KiB.
