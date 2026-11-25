// @authalla/nextjs/client: the browser side. Free of Next.js, so it works in
// any React app whose server mounts the core route handler.
export { AuthallaProvider, useAuth, SignedIn, SignedOut, type AuthState, type SignInOptions, type SignInError } from "./provider.js";
export { UserApiError, type UserApi, type Me, type UserSession, type ConnectedApp, type ConnectedApps, type Passkey } from "../core/user-api.js";
export type { ClientSession, SessionUser } from "../core/session.js";
