# @authalla/nextjs

Add [Authalla](https://authalla.com) sign-in to a Next.js 16 app that uses the App Router.

- Users sign in on your Authalla sign-in page with the methods your tenant has turned on, such as email codes, passkeys, and social and enterprise logins.
- You get the signed-in user from `auth()` on the server and from `useAuth()` in Client Components.
- The tokens stay on your server, in an encrypted cookie that the browser can't read.
- The User API client lets users manage their own account: their name, their signed-in devices, the apps they connected, and their passkeys.
- `getAccessToken()` gives you a token to call your own API.

It needs Next.js 16 or later, React 19, and Node.js 20.9 or later.

## Set up sign-in

1. In the Authalla dashboard, open your app. Add the redirect URI `https://your-app.example.com/api/auth/callback` and the logout URI `https://your-app.example.com`. For local development, also add `http://localhost:3000/api/auth/callback` and `http://localhost:3000`.

2. Install the package:

   ```bash
   npm install @authalla/nextjs
   ```

3. Set the environment:

   ```bash
   # .env.local
   AUTHALLA_ISSUER=https://acme.authalla.com      # your tenant's URL
   AUTHALLA_CLIENT_ID=...                          # your app's client ID
   AUTHALLA_SECRET=...                             # openssl rand -base64 32
   AUTHALLA_APP_URL=https://your-app.example.com   # required in production
   # AUTHALLA_CLIENT_SECRET=...                    # only for a confidential app
   ```

   `AUTHALLA_SECRET` encrypts the session cookie. If you change it, every user is signed out.

4. Create the client:

   ```ts
   // lib/authalla.ts
   import { createAuthalla } from "@authalla/nextjs";

   export const authalla = createAuthalla();
   ```

5. Mount the route handler. It signs users in and out, and serves the browser's session and User API calls.

   ```ts
   // app/api/auth/[...authalla]/route.ts
   import { authalla } from "@/lib/authalla";

   export const { GET, POST, PATCH, DELETE } = authalla.handlers;
   ```

6. Add the proxy next to `app/`, or in `src/` if you use one. It refreshes the tokens before a page renders.

   ```ts
   // proxy.ts
   import { authalla } from "@/lib/authalla";

   export const proxy = authalla.proxy;
   export const config = { matcher: ["/((?!api/|_next/|.*\\..*).*)"] };
   ```

7. Wrap the root layout in the provider. Pass the promise from `clientSession()` without `await`, so that Next.js can still prerender your pages.

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

8. Add a sign-in button:

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

Click **Sign in**. Your Authalla sign-in page opens. After you sign in, you come back to the same page.

## Guides

### Protect a page

Call `requireSession()`. It returns the session, or sends the visitor to sign in and then back to the same page.

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

The server functions read cookies, so put the component that calls them inside `<Suspense>`. Next.js requires that when Cache Components are on, which is the default in a new app.

To send the user somewhere other than the current page, pass a path: `requireSession("/welcome")`. Without the proxy, the default is `/`.

To show signed-out visitors something instead of redirecting them, use `auth()`. It returns `null` when nobody is signed in.

```tsx
async function Greeting() {
  const session = await authalla.auth();
  if (!session) return <a href={authalla.signInUrl()}>Sign in</a>;
  return <p>Hello, {session.user.name}</p>;
}
```

Also check `auth()` in every Server Action and Route Handler that needs a signed-in user. A hidden button doesn't stop a request.

### Show the user in Client Components

```tsx
"use client";
import { useAuth, SignedIn, SignedOut } from "@authalla/nextjs/client";

export function Header() {
  const { user, signIn, signOut } = useAuth();
  return (
    <header>
      <SignedIn>
        {user?.picture && <img src={user.picture} alt="" />}
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

`user` has `id`, `name`, `email`, `emailVerified`, `picture`, and `claims`. See [`SessionUser`](#types). To link the user to your own data, use `user.id`, because the email can change.

`status` is `"loading"` until the session arrives from the layout. To show the user on the first render instead, call `useAuth({ suspense: true })` in a component inside `<Suspense>`:

```tsx
<Suspense fallback={<MenuPlaceholder />}>
  <UserMenu /> {/* calls useAuth({ suspense: true }) */}
</Suspense>
```

### Sign in and out from the server

Link to `signInUrl()`. It reads no request data, so a prerendered page can use it. To sign out, call `signOut()` in a Server Action:

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

`signOut()` throws in a Server Component, because a Server Component can't clear cookies.

### Let users manage their account

The User API reads and changes the signed-in user's own Authalla account. `userApi` works the same on the server and in the browser. In the browser, calls go through your route handler, which adds the access token.

1. In the dashboard, allow the scopes for your app.

2. Ask for the scopes at sign-in. `scopes` replaces the default list, so keep the defaults:

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

   Users who are already signed in get the new scopes the next time they sign in. Until then, calls that need them throw `UserApiError` with `status` 403.

3. Call the User API. To change the user's name, use a Server Action:

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

   To list the user's signed-in devices and sign one out, use a Client Component:

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
             {s.user_agent}, signed in with {s.auth_method}
             {s.current ? " (this browser)" : <button onClick={() => end(s.id)}>Sign out</button>}
           </li>
         ))}
       </ul>
     );
   }
   ```

If your API is an Authalla resource server, such as an MCP server, AI agents like Claude and ChatGPT register themselves and ask the user for consent to call it. `listConnectedApps()` lists the agents that can act for the user. `revokeConnectedApp(id)` revokes an agent's tokens and consent:

```ts
const { connected_apps } = await authalla.userApi.listConnectedApps();
await authalla.userApi.revokeConnectedApp(connected_apps[0].id);
```

For every call and the scope it needs, see [User API](#user-api).

### Add passkeys

Call `addPasskey()`. It sends the user to your Authalla sign-in page to create a passkey, and then back. For the reason, see [Why passkeys are created on the Authalla sign-in page](#why-passkeys-are-created-on-the-authalla-sign-in-page).

```tsx
const { addPasskey } = useAuth();

<button onClick={() => addPasskey({ returnTo: "/account/passkeys" })}>Add a passkey</button>
```

If the user didn't sign in during the last five minutes, they sign in again first. If they choose **Not now**, `signInError` is `{ code: "access_denied", prompt: "passkey" }`.

To list, rename, and remove passkeys, use `userApi.listPasskeys()`, `renamePasskey(id, name)`, and `removePasskey(id)`.

### Call your own API

`getAccessToken()` returns an access token that is valid for at least another minute, or `null` when nobody is signed in:

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

Your API checks the token against your tenant's keys at `https://acme.authalla.com/.well-known/jwks.json`. To get a token for your API, register the API as a resource server in the dashboard and add its scopes to `scopes`.

In a Server Component, `getAccessToken()` can't save a refreshed token, so it returns the stored one. The proxy refreshes the token before each page.

### Make the user sign in again before a sensitive action

Before an action like deleting an account, ask the user to prove it's still them:

```ts
signIn({ prompt: "login", returnTo: "/account/delete" }); // always
signIn({ maxAge: 300, returnTo: "/account/delete" });     // if they signed in more than 5 minutes ago
```

On the server, read when the user signed in from the `auth_time` claim, in seconds since the epoch:

```ts
const session = await authalla.requireSession();
if (Date.now() / 1000 - Number(session.user.claims.auth_time) > 300) {
  redirect(authalla.signInUrl({ maxAge: 300, returnTo: "/account/delete" }));
}
```

### Handle errors

- If the user cancels sign-in, they come back to `returnTo`, and `useAuth().signInError` is set once, for example to `{ code: "access_denied" }`.
- If the session ends elsewhere, for example through an admin's **Sign out everywhere**, the user is signed out and `useAuth().sessionEnded` is `true`.
- If a User API call fails, it throws `UserApiError` with `status`, `code`, and `message`. `status` 401 means that the session is over, 403 means that the token lacks the scope, and 0 means that Authalla didn't answer.
- If configuration is missing, the first request throws `ConfigError` with the name of the variable to set. `next build` doesn't need the environment.

## Reference

### `createAuthalla(options?)`

Each option falls back to its environment variable. The SDK reads the environment on each request.

| Option | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `issuer` | `AUTHALLA_ISSUER` | Required | Your tenant's URL. |
| `clientId` | `AUTHALLA_CLIENT_ID` | Required | Your app's client ID. |
| `secret` | `AUTHALLA_SECRET` | Required | Encrypts the session cookie. At least 32 characters. |
| `appUrl` | `AUTHALLA_APP_URL` | The request's origin, outside production | Your app's public origin. Required in production. |
| `clientSecret` | `AUTHALLA_CLIENT_SECRET` | None | For a confidential app. |
| `scopes` | | `openid profile email offline_access` | The scopes to ask for. Replaces the default list. |
| `basePath` | | `/api/auth` | Where the route handler is mounted. Pass the same value to `<AuthallaProvider>`. |
| `postLogoutRedirectUri` | | `appUrl` | Where Authalla sends the browser after sign-out. Must be one of the app's logout URIs. |

The redirect URI is `appUrl` plus `basePath` plus `/callback`. Cookies are `Secure` when `appUrl` starts with `https://`.

### Server

`createAuthalla()` returns:

| Member | Returns | Description |
| --- | --- | --- |
| `handlers` | | `GET`, `POST`, `PATCH`, `PUT`, and `DELETE` for `app/api/auth/[...authalla]/route.ts`. |
| `proxy` | | For `proxy.ts`. Refreshes the tokens before a page renders, and passes the page's path to `requireSession()`. Leave the route handler's path out of its matcher. |
| `auth()` | `Session \| null` | The signed-in session. In Server Actions and Route Handlers, refreshes an access token that expires within a minute. |
| `requireSession(returnTo?)` | `Session` | The session, or a redirect to sign-in that comes back to `returnTo`. The default is the current page with the proxy, and `/` without it. |
| `getAccessToken({ force? })` | `string \| null` | An access token valid for at least a minute, refreshed if needed. `force` refreshes now. In a Server Component, returns the stored token. |
| `userApi` | | The [User API](#user-api) as the signed-in user. |
| `signInUrl(options?)` | `string` | The path that starts a sign-in. Takes the [sign-in options](#sign-in-options). |
| `signOut()` | `never` | Revokes the tokens, clears the cookie, and redirects to Authalla's logout. Server Actions and Route Handlers only. |
| `clientSession()` | `ClientSession` | The session for `<AuthallaProvider>`, without tokens. |

`auth()`, `requireSession()`, `getAccessToken()`, `signOut()`, and `clientSession()` return a promise.

### Browser

`@authalla/nextjs/client` doesn't import Next.js, so any React app whose server mounts the route handler can use it.

`<AuthallaProvider session? basePath?>` gives Client Components the session. `session` is `authalla.clientSession()`, as a promise or awaited. Without it, the provider fetches the session. `basePath` defaults to `/api/auth`. The provider loads the session again when the tab becomes visible.

`useAuth({ suspense? })` returns:

| Member | Description |
| --- | --- |
| `status` | `"loading"`, `"signed-in"`, or `"signed-out"`. |
| `user` | The [`SessionUser`](#types), or `undefined`. |
| `signIn(options?)` | Sends the browser to sign in. Takes the [sign-in options](#sign-in-options). `returnTo` defaults to the current page. |
| `signOut()` | Revokes the tokens, ends the Authalla session, and comes back signed out. |
| `addPasskey({ returnTo?, loginHint?, uiLocales? })` | Sends the signed-in user to Authalla to add a passkey, and then back. |
| `refresh({ force? })` | Reloads the session. `force` gets new tokens first. |
| `sessionEnded` | `true` when the session ended without `signOut()`. |
| `signInError` | `{ code, description?, prompt? }`, set once after a sign-in that didn't finish. |
| `userApi` | The [User API](#user-api), through the route handler. |

With `suspense: true`, `useAuth()` suspends until the session is known instead of returning `"loading"`.

`<SignedIn>` renders its children only when the user is signed in. `<SignedOut>` renders them only when the user is signed out. Neither renders while the session loads.

### Sign-in options

| Option | Description |
| --- | --- |
| `returnTo` | The path to come back to. A value that isn't a path on your app becomes `/`. |
| `prompt` | `"create"` opens sign-up. `"login"` makes a signed-in user sign in again. `"passkey"` adds a passkey, which `addPasskey()` does for you. |
| `maxAge` | The user signs in again if their last sign-in was more than this many seconds ago. |
| `loginHint` | The email to fill in. |
| `uiLocales` | The sign-in page's language, for example `"fi"` or `"sv en"`. |

### User API

Each call throws `UserApiError` when it fails.

| Call | Returns | Scope | Description |
| --- | --- | --- | --- |
| `getMe()` | `Me` | `profile`, and `email` for the email | The user's ID, name, and email. |
| `updateMe({ name })` | `Me` | `profile` | Changes the user's name and refreshes the session. |
| `listSessions()` | `UserSession[]` | `sessions:read` | The browsers the user is signed in on. |
| `endSession(id)` | `void` | `sessions:write` | Signs that browser out. |
| `listConnectedApps()` | `ConnectedApps` | `connected-apps:read` | The apps that hold the user's consent or tokens. |
| `revokeConnectedApp(id)` | `void` | `connected-apps:write` | Revokes the app's tokens and consent. APIs that check tokens locally accept its last access token for up to `access_token_lifetime_seconds`. |
| `listPasskeys()` | `Passkey[]` | `passkeys:read` | The user's passkeys. |
| `renamePasskey(id, name)` | `Passkey` | `passkeys:write` | Renames a passkey. |
| `removePasskey(id)` | `void` | `passkeys:write` | Removes a passkey. |

For the fields of each type, see the [User API reference](https://docs.authalla.com/docs/user-api).

### Route handler

The route handler is mounted at `basePath`. The SDK's functions call these routes. The handler refuses `POST`, `PATCH`, `PUT`, and `DELETE` requests from other origins.

| Route | Description |
| --- | --- |
| `GET /signin` | Starts a sign-in. Takes `returnTo`, `prompt`, `max_age`, `login_hint`, and `ui_locales`. |
| `GET /callback` | Where Authalla redirects back. Stores the session and redirects to `returnTo`. |
| `POST /signout` | Revokes the tokens, clears the session, and redirects to Authalla's logout. |
| `GET /session` | The `ClientSession`. |
| `POST /refresh` | Gets new tokens. |
| `/me` and `/me/...` | The User API, with the session's access token. |

### Types

```ts
type SessionUser = {
  id: string;                      // the user's Authalla ID, the tokens' sub
  name?: string;
  email?: string;                  // with the email scope
  emailVerified?: boolean;
  picture?: string;                // from a social login, when there is one
  claims: Record<string, unknown>; // every claim of the ID token, such as auth_time and org_id
};

type Session = {                   // server only
  user: SessionUser;
  accessToken: string;
  idToken: string;
  expiresAt: number;               // when the access token expires, in milliseconds since the epoch
  scopes: string[];
};

type ClientSession =               // for the browser, without tokens
  | { status: "signed-in"; user: SessionUser; expiresAt: number; scopes: string[] }
  | { status: "signed-out"; ended: boolean };
```

Both `@authalla/nextjs` and `@authalla/nextjs/client` also export `Me`, `UserSession`, `ConnectedApp`, `ConnectedApps`, `Passkey`, and `UserApiError`.

### Entry points

| Import | Contents |
| --- | --- |
| `@authalla/nextjs` | `createAuthalla()` and the server side. |
| `@authalla/nextjs/client` | The provider and hooks. No Next.js. |
| `@authalla/nextjs/core` | OAuth, the session cookie, and the route handler, on Web `Request` and `Response`. No Next.js or React. For adapters to other frameworks. |

## How it works

### Why the tokens stay on the server

Any script that runs on your page can steal a token that the browser holds. So the SDK follows the backend-for-frontend pattern from the OAuth 2.0 for Browser-Based Apps best practice. Your server holds the tokens, and the browser holds only a cookie.

- The access, refresh, and ID tokens are stored in an encrypted, `httpOnly`, `SameSite=Lax` cookie for up to 30 days. Over `https://`, the cookie is also `Secure`.
- Sign-in uses PKCE, `state`, and a `nonce`. A separate, short-lived encrypted cookie holds them.
- `returnTo` accepts only paths on your app, so nobody can use your sign-in links to redirect users to another site.
- The route handler refuses sign-out, refresh, and User API changes from other origins.
- When an admin revokes a session at Authalla, the user is signed out the next time the tokens are refreshed. The proxy refreshes them shortly before the access token expires.

### Why passkeys are created on the Authalla sign-in page

The browser binds each passkey to the domain of the page that creates it, and offers the passkey only on that domain. Users sign in on your Authalla sign-in page, so their passkeys have to be created there. A custom domain doesn't change that. If users sign in on `login.customer.com`, their passkeys belong to `login.customer.com`, and a page on `customer.com` can't create them.

## Report a vulnerability

Report vulnerabilities privately, as [SECURITY.md](https://github.com/Authalla/authalla-nextjs/blob/main/SECURITY.md) describes. Don't open a public issue.

## Example app

[`examples/nextjs-app`](https://github.com/Authalla/authalla-nextjs/tree/main/examples/nextjs-app) is set up like a new `create-next-app`, with Cache Components on. It shows sign-in and sign-out from the server and the browser, a protected page, a Server Action that changes the user's name, and the user's passkeys.

## Develop

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
pnpm example   # builds the example app and smoke-tests it with next start
```

To run the example against your tenant, copy `examples/nextjs-app/.env.example` to `.env.local` and fill it in. Then run `pnpm build && pnpm --filter authalla-nextjs-example dev`.

To release a version, see [RELEASING.md](https://github.com/Authalla/authalla-nextjs/blob/main/RELEASING.md).

## License

MIT
