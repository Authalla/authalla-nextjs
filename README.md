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
   import { authalla } from "@/lib/authalla";
   export const { GET, POST, PATCH, DELETE } = authalla.handlers;

   // proxy.ts, next to app/ (in src/ if you use it): refreshes tokens before a page renders
   import { authalla } from "@/lib/authalla";
   export const proxy = authalla.proxy;
   export const config = { matcher: ["/((?!api/|_next/|.*\\..*).*)"] };
   ```

4. Add the provider to the root layout, so Client Components can call
   `useAuth()`. Pass the promise, not awaited: the layout then doesn't wait
   for cookies, which Next.js requires with Cache Components (on in a new
   `create-next-app`).

   ```tsx
   // app/layout.tsx
   import { AuthallaProvider } from "@authalla/nextjs/client";
   import { authalla } from "@/lib/authalla";

   export default function RootLayout({ children }: LayoutProps<"/">) {
     return (
       <html lang="en">
         <body>
           <AuthallaProvider session={authalla.clientSession()}>{children}</AuthallaProvider>
         </body>
       </html>
     );
   }
   ```

## On the server

```ts
const session = await authalla.auth();         // Session | null
session?.user;                                 // { id, name, email, emailVerified, claims }
await authalla.requireSession("/account");     // or redirect to sign-in, back to /account
await authalla.getAccessToken();               // for calling your own API
await authalla.userApi.listSessions();         // the User API, as the signed-in user
authalla.signInUrl({ returnTo: "/account" });  // "/api/auth/signin?returnTo=%2Faccount", for an <a href>
await authalla.signOut();                      // in a Server Action: sign out and go to Authalla's logout
```

`signInUrl()` takes the same options as the browser's `signIn()` and reads
no request data, so a prerendered page can link to sign-in. `signOut()`
must run in a Server Action or Route Handler, where it can clear the
cookie:

```tsx
// app/actions.ts
"use server";
export async function signOutAction() {
  await authalla.signOut();
}

// in a Server Component
<form action={signOutAction}><button>Sign out</button></form>
```

These read the request's cookies. With Cache Components, put the Server
Component that calls them inside `<Suspense>`, as for any request data:

```tsx
// app/account/page.tsx
async function Account() {
  const { user } = await authalla.requireSession("/account");
  return <p>Signed in as {user.email}</p>;
}

export default function Page() {
  return <Suspense fallback={<p>Loading…</p>}><Account /></Suspense>;
}
```

Inside `<Suspense>`, `requireSession()` redirects in the browser once the
page streams, rather than with a 307 status.

In a Server Action, `userApi` and `getAccessToken()` can refresh the tokens
and store them. Changing the name with `userApi.updateMe()` refreshes the
session too, so `auth()` returns the new name.

## In the browser

```tsx
"use client";
import { useAuth, SignedIn, SignedOut } from "@authalla/nextjs/client";

const { status, user, signIn, signOut, addPasskey, refresh, sessionEnded, signInError, userApi } = useAuth();
signIn({ loginHint: "jane@example.com", uiLocales: "fi", prompt: "create" });
await userApi.updateMe({ name: "Jane Smith" }); // the session's ID token is refreshed to match

<SignedIn><button onClick={() => signOut()}>Sign out</button></SignedIn>
<SignedOut><button onClick={() => signIn()}>Sign in</button></SignedOut>
```

`status` is `"loading"` until the session from the layout arrives. For a
component that should never show that, such as the header's user menu, use
`useAuth({ suspense: true })` inside `<Suspense>`: it waits for the session
instead, so its first render, on the server too, already shows the user,
and the page around it is still prerendered.

```tsx
<Suspense fallback={<MenuPlaceholder />}>
  <UserMenu /> {/* calls useAuth({ suspense: true }) */}
</Suspense>
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

`userApi` is the same on both sides. Each call needs a scope, which the
app must be allowed in the dashboard and ask for at sign-in:

| Calls | Scope |
| --- | --- |
| `getMe`, `updateMe` | `profile` (and `email` for the email) |
| `listSessions` / `endSession` | `sessions:read` / `sessions:write` |
| `listConnectedApps` / `revokeConnectedApp` | `connected-apps:read` / `connected-apps:write` |
| `listPasskeys` / `renamePasskey`, `removePasskey` | `passkeys:read` / `passkeys:write` |

`scopes` replaces the default list (`openid profile email offline_access`),
so keep those:

```ts
export const authalla = createAuthalla({
  scopes: ["openid", "profile", "email", "offline_access", "passkeys:read", "passkeys:write"],
});
```

A user signed in before you added a scope gets it when they next sign in.
See the [User API reference](https://docs.authalla.com/docs/user-api).
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

## Example

[`examples/nextjs-app`](examples/nextjs-app) is a small app set up the way a
new `create-next-app` is, with Cache Components on: sign-in and sign-out
from the server and the browser, a protected page, a Server Action changing
the user's name, and the user's passkeys. To run it against your tenant,
copy its `.env.example` to `.env.local`, fill it in, then
`pnpm build && pnpm --filter authalla-nextjs-example dev`.

## Development

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
pnpm example   # builds the example app and smoke-tests it with next start
```

CI runs both, so a change that stops a Cache Components app from building
fails CI.

## Releasing

1. Bump `version` in `package.json` and add its entry to `CHANGELOG.md`.
2. Commit, then tag and push: `git tag v0.2.0 && git push origin main v0.2.0`.

The Release workflow tests and builds the tag, checks the package contents,
and publishes to npm with provenance through npm trusted publishing: no npm
token is stored anywhere. It then creates the GitHub release.
