# @authalla/nextjs

Sign in with [Authalla](https://authalla.com) in a Next.js app (16+, App Router).

- **Sign-in and sign-out** through your Authalla tenant's hosted pages:
  email codes, passkeys, social and enterprise logins, whatever the tenant
  has turned on. OAuth 2.1 authorization code flow with PKCE.
- **The signed-in user everywhere**: `auth()` in Server Components, Server
  Actions and Route Handlers; `useAuth()` in Client Components.
- **Tokens stay on your server**, sealed in an encrypted, httpOnly cookie the
  browser can't read: the "backend for frontend" pattern the OAuth 2.0 for
  Browser-Based Apps BCP recommends. A proxy refreshes them before pages
  render.
- **Account pages without your own backend**: the typed User API client lets
  the signed-in user change their name, see and end their sessions on other
  devices, revoke apps they connected, and manage their passkeys.
- **Access tokens for your own API** with `getAccessToken()`.

```text
Browser ──── session cookie (encrypted, httpOnly) ────▶ Your Next.js app ──── access token ────▶ Authalla
        ◀─── the user (name, email), never tokens ─────                  ◀─── tokens, User API ───
```

## Contents

- [Set up](#set-up)
- [Guides](#guides): protect a page, show the user, sign in and out, an
  account page, your own API, sign in again before sensitive actions,
  errors
- [Reference](#reference): options, server, browser, User API, route
  handler, types
- [Security](#security)

## Set up

You need an Authalla tenant and an app in it. In the Authalla dashboard,
open the app and add:

- the redirect URI `https://your-app.example.com/api/auth/callback`
- the logout URI `https://your-app.example.com`

For local development add `http://localhost:3000/api/auth/callback` and
`http://localhost:3000` too.

### 1. Install

```bash
npm install @authalla/nextjs
```

It needs Next.js 16 or newer, React 19 and Node.js 20.9 or newer.

### 2. Set the environment

```bash
# .env.local
AUTHALLA_ISSUER=https://acme.authalla.com      # your tenant's URL
AUTHALLA_CLIENT_ID=...                          # your app's client ID
AUTHALLA_SECRET=...                             # openssl rand -base64 32
AUTHALLA_APP_URL=https://your-app.example.com   # required in production
# AUTHALLA_CLIENT_SECRET=...                    # only for a confidential app
```

`AUTHALLA_SECRET` encrypts the session cookie. Keep it secret and at least
32 characters long. Changing it signs everyone out.

### 3. Create the client, its route handler and the proxy

```ts
// lib/authalla.ts
import { createAuthalla } from "@authalla/nextjs";

export const authalla = createAuthalla();
```

```ts
// app/api/auth/[...authalla]/route.ts
import { authalla } from "@/lib/authalla";

export const { GET, POST, PATCH, DELETE } = authalla.handlers;
```

```ts
// proxy.ts, next to app/ (in src/ if you use it)
import { authalla } from "@/lib/authalla";

export const proxy = authalla.proxy;
export const config = { matcher: ["/((?!api/|_next/|.*\\..*).*)"] };
```

The route handler signs users in and out and serves the browser's session
and User API calls ([routes](#route-handler)). The proxy refreshes the
tokens before a page renders, so Server Components always read fresh ones,
and tells `requireSession()` which page to come back to.

### 4. Add the provider to the root layout

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

Pass the promise, not awaited. The layout then doesn't wait for cookies,
which Next.js requires with Cache Components (on in a new
`create-next-app`), and pages can still be prerendered.

### 5. Add a sign-in button

```tsx
// app/sign-in-button.tsx
"use client";
import { useAuth } from "@authalla/nextjs/client";

export function SignInButton() {
  const { status, user, signIn, signOut } = useAuth();
  if (status === "loading") return null;
  if (!user) return <button onClick={() => signIn()}>Sign in</button>;
  return <button onClick={() => signOut()}>Sign out {user.name}</button>;
}
```

Clicking Sign in opens your tenant's sign-in page and comes back to the
same page, signed in.

## Guides

### Protect a page

`requireSession()` returns the session, or sends a signed-out visitor to
sign in and back to the same page.

```tsx
// app/account/page.tsx
import { Suspense } from "react";
import { authalla } from "@/lib/authalla";

async function Account() {
  const { user } = await authalla.requireSession();
  return <p>Signed in as {user.email}</p>;
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <Account />
    </Suspense>
  );
}
```

`auth()`, `requireSession()` and the other server methods read the
request's cookies. With Cache Components, put the component that calls
them inside `<Suspense>`, as for any request data. Inside `<Suspense>`,
`requireSession()` redirects in the browser once the page streams, rather
than with a 307.

Server Components can't read their own URL in Next.js, so the proxy passes
the page's path on and `requireSession()` comes back to it. Without the
proxy it comes back to `/`. To send the user somewhere else, pass the path:
`requireSession("/welcome")`.

To show something different to signed-out visitors instead of redirecting,
use `auth()`:

```tsx
async function Greeting() {
  const session = await authalla.auth();
  if (!session) return <a href={authalla.signInUrl({ returnTo: "/" })}>Sign in</a>;
  return <p>Hello, {session.user.name}</p>;
}
```

Protect Server Actions and Route Handlers the same way: call `auth()` and
refuse when it returns `null`. Hiding a button in the UI is not a check.

### Show the user in Client Components

```tsx
"use client";
import { useAuth, SignedIn, SignedOut } from "@authalla/nextjs/client";

export function Header() {
  const { user, signIn, signOut } = useAuth();
  return (
    <header>
      <SignedIn>
        <span>{user?.name}</span>
        <button onClick={() => signOut()}>Sign out</button>
      </SignedIn>
      <SignedOut>
        <button onClick={() => signIn()}>Sign in</button>
      </SignedOut>
    </header>
  );
}
```

`user` holds what Authalla knows about the signed-in user:

| | |
| --- | --- |
| `user.name` | Their name. |
| `user.email` | Their email address, with the `email` scope. |
| `user.emailVerified` | Whether they proved they own the email address. |
| `user.picture` | Their profile picture from a social login (Google, GitHub…), when they signed in with one. |
| `user.id` | Their Authalla user ID. Use it, not the email, to link the user to your own data. |
| `user.claims` | Every claim of the ID token, e.g. `org_id` when they signed in through an Organization. |

`status` is `"loading"` until the session from the layout arrives. For a
component that should never show that, such as the header's user menu, use
`useAuth({ suspense: true })` inside `<Suspense>`: it waits for the session,
so its first render, on the server too, already shows the user, and the
page around it is still prerendered.

```tsx
<Suspense fallback={<MenuPlaceholder />}>
  <UserMenu /> {/* calls useAuth({ suspense: true }) */}
</Suspense>
```

The provider checks the session again whenever the tab comes back into
view, so a user signed out elsewhere shows as signed out.

### Sign in and out

From the browser, `signIn()` and `signOut()` from `useAuth()`. From the
server, link to `signInUrl()` and call `signOut()` in a Server Action:

```tsx
// app/actions.ts
"use server";
import { authalla } from "@/lib/authalla";

export async function signOutAction() {
  await authalla.signOut();
}
```

```tsx
// in a Server Component
<a href={authalla.signInUrl({ returnTo: "/dashboard" })}>Sign in</a>
<form action={signOutAction}><button>Sign out</button></form>
```

`signInUrl()` reads no request data, so a prerendered page can use it.
`signOut()` must run in a Server Action or Route Handler, where it can
clear the cookie; it throws in a Server Component.

Signing out revokes the app's tokens at Authalla, clears the session
cookie, and ends the user's Authalla session through its logout page, which
sends them back to `AUTHALLA_APP_URL` (or `postLogoutRedirectUri`).

Sign-in options, for both `signIn()` and `signInUrl()`:

```ts
signIn({ returnTo: "/welcome" });            // where to land afterwards (default: the current page)
signIn({ prompt: "create" });                // open on sign-up instead of sign-in
signIn({ loginHint: "jane@example.com" });   // fill in the email
signIn({ uiLocales: "fi" });                 // the page's language
```

### Build an account page with the User API

The User API is what a signed-in user can see and change about their own
Authalla account. `userApi` is the same on both sides: on the server it
calls Authalla with the session's access token; in the browser it goes
through your route handler, which adds the token there, so the browser
never holds it.

Each call needs a scope. Allow the scopes on the app in the dashboard and
ask for them at sign-in. `scopes` replaces the default list
(`openid profile email offline_access`), so keep those:

```ts
// lib/authalla.ts
export const authalla = createAuthalla({
  scopes: [
    "openid", "profile", "email", "offline_access",
    "sessions:read", "sessions:write",
    "connected-apps:read", "connected-apps:write",
    "passkeys:read", "passkeys:write",
  ],
});
```

A user who signed in before you added a scope gets it when they next sign
in. Until then the call throws `UserApiError` with `status` 403.

**Change the user's name**, in a Server Action:

```ts
// app/account/actions.ts
"use server";
import { revalidatePath } from "next/cache";
import { authalla } from "@/lib/authalla";

export async function rename(formData: FormData) {
  await authalla.userApi.updateMe({ name: String(formData.get("name")) });
  revalidatePath("/account");
}
```

After `updateMe()` the SDK refreshes the session, so `auth()` and
`useAuth()` show the new name.

**List where the user is signed in, and sign one device out:**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useAuth, type UserSession } from "@authalla/nextjs/client";

export function Devices() {
  const { userApi } = useAuth();
  const [sessions, setSessions] = useState<UserSession[]>([]);
  useEffect(() => {
    userApi.listSessions().then(setSessions);
  }, [userApi]);

  async function end(id: string) {
    await userApi.endSession(id);
    setSessions(await userApi.listSessions());
  }

  return (
    <ul>
      {sessions.map((s) => (
        <li key={s.id}>
          {s.user_agent}, signed in with {s.auth_method} on {new Date(s.created_at).toLocaleDateString()}
          {s.current ? " (this browser)" : <button onClick={() => end(s.id)}>Sign out</button>}
        </li>
      ))}
    </ul>
  );
}
```

**Show the apps the user has connected**, and revoke one. This matters
most when your API, such as an MCP server, is an Authalla resource server:
AI agents like Claude and ChatGPT register themselves and get the user's
consent to call it. This list is where the user sees which agents can act
for them, and cuts one off:

```ts
const { connected_apps } = await authalla.userApi.listConnectedApps();
await authalla.userApi.revokeConnectedApp(connected_apps[0].id);
```

**Manage passkeys.** `addPasskey()` sends the user to Authalla to create
one and back; list, rename and remove them with the User API.

A passkey belongs to one website: the browser binds it to the domain of
the page that created it, and only offers it on that domain. Users sign in
on your Authalla sign-in page, so their passkeys must be created there,
not on your app's pages. That holds with a custom domain too: a passkey
for `login.customer.com` is created on `login.customer.com`, even if your
app runs on `customer.com`.

```tsx
const { addPasskey, userApi } = useAuth();

<button onClick={() => addPasskey({ returnTo: "/account/passkeys" })}>Add a passkey</button>

const passkeys = await userApi.listPasskeys();
await userApi.renamePasskey(passkeys[0].id, "Work laptop");
await userApi.removePasskey(passkeys[0].id);
```

The user signs in again before adding a passkey unless they did within the
last five minutes. If they choose Not now, they come back with
`signInError` `{ code: "access_denied", prompt: "passkey" }`.

### Call your own API

`getAccessToken()` returns an access token with at least a minute left,
refreshing it first if needed, or `null` when nobody is signed in:

```ts
// app/orders/actions.ts
"use server";
import { authalla } from "@/lib/authalla";

export async function listOrders() {
  const token = await authalla.getAccessToken();
  if (!token) throw new Error("Not signed in");
  const response = await fetch("https://api.example.com/orders", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return response.json();
}
```

Your API validates the token against your tenant's JWKS
(`https://acme.authalla.com/.well-known/jwks.json`). For a token meant for
your API, register it as a resource server in the dashboard and add its
scopes to `scopes`.

In a Server Component, `getAccessToken()` returns the token as it is,
because a Server Component can't store a refreshed one. The proxy keeps it
fresh before each page.

### Sign in again before a sensitive action

Before deleting an account or changing payment details, make the user
prove it's still them:

```ts
signIn({ prompt: "login", returnTo: "/account/delete" });  // always sign in again
signIn({ maxAge: 300, returnTo: "/account/delete" });      // only if they last signed in over 5 minutes ago
```

On the server, check how long ago they signed in with the ID token's
`auth_time` claim (seconds since the epoch):

```ts
const session = await authalla.requireSession("/account/delete");
const authTime = Number(session.user.claims.auth_time);
if (Date.now() / 1000 - authTime > 300) redirect(authalla.signInUrl({ maxAge: 300, returnTo: "/account/delete" }));
```

### Handle errors

- **The user cancelled sign-in**, or Authalla refused it: they come back to
  `returnTo` and `useAuth().signInError` is set once, e.g.
  `{ code: "access_denied" }`. The SDK removes the error from the address.
- **The session ended elsewhere**: an admin's Sign out everywhere, a
  suspended user, an expired refresh token. The user is signed out and
  `useAuth().sessionEnded` is true, so you can say why.
- **A User API call failed**: it throws `UserApiError` with `status`,
  `code` and `message`. 401 means the session is over, 403 that the token
  lacks the call's scope, 0 that Authalla didn't answer.
- **Configuration is missing**: the first request throws `ConfigError`
  naming the environment variable to set. `next build` doesn't need the
  environment.

```ts
import { UserApiError } from "@authalla/nextjs";

try {
  await authalla.userApi.listPasskeys();
} catch (err) {
  if (err instanceof UserApiError && err.status === 403) {
    // Ask the user to sign in again to grant passkeys:read.
  }
  throw err;
}
```

## Reference

### `createAuthalla(options?)`

From `@authalla/nextjs`. Every option falls back to its environment
variable, which is read on each request, not at import.

| Option | Environment | Default | |
| --- | --- | --- | --- |
| `issuer` | `AUTHALLA_ISSUER` | required | Your tenant's URL, e.g. `https://acme.authalla.com`. |
| `clientId` | `AUTHALLA_CLIENT_ID` | required | Your app's client ID. |
| `secret` | `AUTHALLA_SECRET` | required | Encrypts the session cookie. At least 32 characters. |
| `appUrl` | `AUTHALLA_APP_URL` | the request's origin, outside production | Your app's public origin. The redirect URI is this plus `/api/auth/callback`. Required in production. |
| `clientSecret` | `AUTHALLA_CLIENT_SECRET` | none | Only for a confidential app. |
| `scopes` | | `openid profile email offline_access` | The scopes to ask for. Replaces the default list. |
| `basePath` | | `/api/auth` | Where the route handler is mounted. Pass the same `basePath` to `<AuthallaProvider>`. |
| `postLogoutRedirectUri` | | `appUrl` | Where Authalla sends the browser after signing out. Must be one of the app's logout URIs. |

Cookies are marked `Secure` when `appUrl` is `https://`.

### Server

What `createAuthalla()` returns:

| | |
| --- | --- |
| `handlers` | `{ GET, POST, PATCH, PUT, DELETE }` for `app/api/auth/[...authalla]/route.ts`. |
| `proxy` | For `proxy.ts`. Refreshes the tokens before a page renders and passes the page's path on to `requireSession()`. Leave the route handler's path out of its matcher. |
| `auth()` | `Promise<Session \| null>`. The signed-in session, or `null`. Doesn't refresh tokens. |
| `requireSession(returnTo?)` | `Promise<Session>`. The session, or a redirect to sign-in that comes back to `returnTo`; by default the current page (with the proxy) or `/`. |
| `getAccessToken({ force? })` | `Promise<string \| null>`. An access token with at least a minute left, refreshed if needed; `force` refreshes now. In a Server Component it returns the stored token without refreshing. |
| `userApi` | The [User API](#user-api) as the signed-in user. |
| `signInUrl(options?)` | `string`. The path that starts a sign-in, e.g. `/api/auth/signin?returnTo=%2Faccount`. Takes the [sign-in options](#sign-in-options). |
| `signOut()` | `Promise<never>`. In a Server Action or Route Handler: revokes the tokens, clears the cookie and redirects to Authalla's logout. |
| `clientSession()` | `Promise<ClientSession>`. The session for `<AuthallaProvider session>`: the user, no tokens. |

### Browser

From `@authalla/nextjs/client`. It doesn't import Next.js, so it works in
any React app whose server mounts the route handler.

**`<AuthallaProvider session? basePath?>`** gives Client Components the
session. `session` is `authalla.clientSession()`, as a promise or awaited;
without it the provider fetches the session from the route handler.
`basePath` defaults to `/api/auth`.

**`useAuth({ suspense? })`** returns:

| | |
| --- | --- |
| `status` | `"loading"`, `"signed-in"` or `"signed-out"`. |
| `user` | The [`SessionUser`](#types), or `undefined`. |
| `signIn(options?)` | Sends the browser to sign in. Takes the [sign-in options](#sign-in-options); `returnTo` defaults to the current page. |
| `signOut()` | Revokes the tokens, ends the Authalla session and comes back signed out. |
| `addPasskey({ returnTo?, loginHint?, uiLocales? })` | Sends the signed-in user to Authalla to add a passkey, then back with a fresh session. |
| `refresh({ force? })` | Reloads the session from the server; `force` gets new tokens from Authalla first. |
| `sessionEnded` | `true` when the user was signed out by something other than `signOut()` here. |
| `signInError` | Set once after a sign-in that came back without signing in: `{ code, description?, prompt? }`. |
| `userApi` | The [User API](#user-api), through the route handler. |

With `suspense: true`, `useAuth()` suspends until the session is known
instead of returning `"loading"`. Use it inside `<Suspense>`.

**`<SignedIn>`** and **`<SignedOut>`** render their children only when the
user is signed in, or signed out. Neither renders while loading.

### Sign-in options

| | |
| --- | --- |
| `returnTo` | The path to land on afterwards. Only paths on your app are followed; anything else lands on `/`. |
| `prompt` | `"create"` opens on sign-up, `"login"` makes the user sign in again even if signed in, `"passkey"` adds a passkey (use `addPasskey()`). |
| `maxAge` | Seconds: the user signs in again if they last did longer ago than this. |
| `loginHint` | Fills in the email on the sign-in page. |
| `uiLocales` | The sign-in page's language, e.g. `"fi"` or `"sv en"`. |

### User API

`userApi` on the server and from `useAuth()`. Every call throws
`UserApiError` on failure.

| Call | Returns | Scope | What it does |
| --- | --- | --- | --- |
| `getMe()` | `Me` | `profile` (+ `email` for the email) | The user's ID, name, email and whether it's verified. |
| `updateMe({ name })` | `Me` | `profile` | Changes the user's name, then refreshes the session so it shows. |
| `listSessions()` | `UserSession[]` | `sessions:read` | The browsers the user is signed in on, with how they signed in, IP address, user agent, and which one is this one. |
| `endSession(id)` | `void` | `sessions:write` | Signs that browser out of Authalla. |
| `listConnectedApps()` | `ConnectedApps` | `connected-apps:read` | The apps holding the user's consent or tokens, with their scopes, when last used, and which is this app. |
| `revokeConnectedApp(id)` | `void` | `connected-apps:write` | Revokes that app's tokens and consent. Its last access token keeps working for at most `access_token_lifetime_seconds` at APIs that check tokens locally. |
| `listPasskeys()` | `Passkey[]` | `passkeys:read` | The user's passkeys, with their names, where they're kept and when last used. |
| `renamePasskey(id, name)` | `Passkey` | `passkeys:write` | Renames a passkey. |
| `removePasskey(id)` | `void` | `passkeys:write` | Removes a passkey, so it no longer signs the user in. |

See also the [User API reference](https://docs.authalla.com/docs/user-api).

### Route handler

Mounted at `basePath` (`/api/auth`). You don't call these yourself: the
SDK's functions do. State-changing requests must come from your own origin.

| Route | |
| --- | --- |
| `GET /signin` | Starts a sign-in at Authalla. Takes `returnTo`, `prompt`, `max_age`, `login_hint`, `ui_locales`. |
| `GET /callback` | Authalla's redirect back. Stores the session and goes to `returnTo`. |
| `POST /signout` | Revokes the tokens, clears the session, redirects to Authalla's logout. |
| `GET /session` | The `ClientSession`, for the browser. |
| `POST /refresh` | New tokens now. |
| `/me`, `/me/…` | The User API with the session's token. |

### Types

```ts
type SessionUser = {
  id: string;                        // the user's ID (the tokens' sub); never changes
  name?: string;
  email?: string;
  emailVerified?: boolean;
  picture?: string;                  // from a social login's profile, when there is one
  claims: Record<string, unknown>;   // every claim of the latest ID token
};

type Session = {                     // server only
  user: SessionUser;
  accessToken: string;
  idToken: string;
  expiresAt: number;                 // the access token's expiry, ms since the epoch
  scopes: string[];
};

type ClientSession =                 // what the browser may know: no tokens
  | { status: "signed-in"; user: SessionUser; expiresAt: number; scopes: string[] }
  | { status: "signed-out"; ended: boolean };
```

`Me`, `UserSession`, `ConnectedApp`, `ConnectedApps` and `Passkey` are
exported too, from both entry points.

### Entry points

- `@authalla/nextjs`: `createAuthalla()` and the server side.
- `@authalla/nextjs/client`: the provider and hooks. No Next.js.
- `@authalla/nextjs/core`: OAuth, the sealed session and the route handler
  on Web `Request` and `Response`. No Next.js, no React; for adapters to
  other frameworks.

## Security

- The browser never receives access, refresh or ID tokens. They live in an
  encrypted, httpOnly, `SameSite=Lax` cookie, `Secure` over https, for at
  most 30 days.
- Sign-in uses PKCE, `state` and a `nonce`, kept in a short-lived encrypted
  cookie of their own.
- `returnTo` only goes to paths on your app, so sign-in links can't be
  used to redirect to another site.
- Sign-out, refresh and User API changes are refused unless the request
  comes from your app's own origin.
- A session whose grant was revoked at Authalla (Sign out everywhere, a
  suspended user) is signed out the next time its tokens are refreshed,
  which the proxy does when the access token is about to expire.

Found a vulnerability? Please report it privately as described in
[SECURITY.md](https://github.com/Authalla/authalla-nextjs/blob/main/SECURITY.md),
not in a public issue.

## Example

[`examples/nextjs-app`](https://github.com/Authalla/authalla-nextjs/tree/main/examples/nextjs-app)
is a small app set up the way a new `create-next-app` is, with Cache
Components on: sign-in and sign-out from the server and the browser, a
protected page, a Server Action changing the user's name, and the user's
passkeys.

## Development

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
pnpm example   # builds the example app and smoke-tests it with next start
```

To run the example against your tenant, copy
`examples/nextjs-app/.env.example` to `.env.local`, fill it in, then
`pnpm build && pnpm --filter authalla-nextjs-example dev`.

Releasing: [RELEASING.md](https://github.com/Authalla/authalla-nextjs/blob/main/RELEASING.md).

## License

MIT
