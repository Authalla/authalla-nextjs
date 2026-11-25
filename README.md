# @authalla/nextjs

Sign in with Authalla in a Next.js app (16+). The tokens stay on your
server, sealed in an encrypted cookie the browser can't read: the "backend
for frontend" pattern the OAuth 2.0 for Browser-Based Apps BCP recommends.
Your pages and components get the user, not the tokens.

## Set up

```bash
npm install @authalla/nextjs
```

1. In the Authalla dashboard, open your app and add the redirect URI
   `https://your-app.example.com/api/auth/callback` and the logout URI
   `https://your-app.example.com`.
2. Set the environment:

   ```bash
   AUTHALLA_ISSUER=https://acme.authalla.com      # your tenant's URL
   AUTHALLA_CLIENT_ID=...                          # your app's client ID
   AUTHALLA_APP_URL=https://your-app.example.com   # optional in development
   AUTHALLA_SECRET=...                             # openssl rand -base64 32
   # AUTHALLA_CLIENT_SECRET=...                    # only for a confidential app
   ```

3. Create the client, mount its route handler and add the proxy:

   ```ts
   // lib/authalla.ts
   import { createAuthalla } from "@authalla/nextjs";
   export const authalla = createAuthalla();

   // app/api/auth/[...authalla]/route.ts
   export const { GET, POST, PATCH, DELETE } = authalla.handlers;

   // proxy.ts: refreshes tokens before a page renders
   export const proxy = authalla.proxy;
   export const config = { matcher: ["/((?!api/|_next/|.*\\..*).*)"] };
   ```

## On the server

```ts
const session = await authalla.auth();         // Session | null
session?.user;                                 // { id, name, email, emailVerified, claims }
await authalla.requireSession("/account");     // or redirect to sign-in, back to /account
await authalla.getAccessToken();               // for calling your own API
await authalla.userApi.listSessions();         // the User API, as the signed-in user
```

## In the browser

```tsx
// app/layout.tsx (a Server Component)
import { AuthallaProvider } from "@authalla/nextjs/client";

<AuthallaProvider session={await authalla.clientSession()}>{children}</AuthallaProvider>

// any Client Component
import { useAuth } from "@authalla/nextjs/client";

const { status, user, signIn, signOut, sessionEnded, signInError, userApi } = useAuth();
signIn({ loginHint: "jane@example.com", uiLocales: "fi", prompt: "create" });
await userApi.updateMe({ name: "Jane Smith" }); // the session's ID token is refreshed to match
```

Before a sensitive action, `signIn({ prompt: "login" })` makes the user sign
in again even though they are signed in, and `signIn({ maxAge: 300 })` only
when they last signed in more than five minutes ago.

`addPasskey({ returnTo })` sends a signed-in user to Authalla to add a
passkey and back with a fresh session. They sign in again first if they
didn't within five minutes. Choosing Not now comes back as
`signInError` `{ code: "access_denied", prompt: "passkey" }`.

`sessionEnded` is true when the user was signed out by something other than
`signOut()`: an admin's Sign out everywhere, a suspended user, an expired
refresh token. `signInError` is set once after a sign-in that came back
without signing in, such as `{ code: "access_denied" }` when the user
cancelled.

## The User API

`userApi` is the same on both sides: `getMe`, `updateMe`, `listSessions`,
`endSession`, `listConnectedApps`, `revokeConnectedApp`, `listPasskeys`,
`renamePasskey` and `removePasskey`. Each needs its scope (see the
[User API reference](https://docs.authalla.com/docs/user-api)), so add it to
`createAuthalla({ scopes })` and to the app's allowed scopes.
A failed call throws `UserApiError`; a 403 means the token lacks the scope.
The types mirror the [User API reference](https://docs.authalla.com/docs/user-api) by hand.

## Layers

- `src/core`: OAuth, the sealed session and the route handler, on Web
  `Request` and `Response`. No Next.js, no React.
- `src/react` (`@authalla/nextjs/client`): the provider and hooks. No Next.js.
- `src/nextjs` (`@authalla/nextjs`): `cookies()`, `headers()`, `redirect()`
  and the proxy.

The lint config enforces the direction, so an adapter for React Router or
TanStack Start can reuse `core` and `react` as they are.

## Development

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

## Releasing

1. Bump `version` in `package.json` and add its entry to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.

The Release workflow tests and builds the tag, checks the package contents,
and publishes to npm with provenance through npm trusted publishing: no npm
token is stored anywhere. It then creates the GitHub release.
