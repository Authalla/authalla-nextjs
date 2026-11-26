// The framework-free core: OAuth, the sealed session cookie and the User API
// on Web-standard Request and Response. Adapters for other frameworks build
// on this; Next.js apps use the package's main entry instead.
export { createCore, safeReturnTo, type AuthallaCore } from "./handler.js";
export { ERROR_PARAM, ERROR_DESCRIPTION_PARAM } from "./constants.js";
export { resolveConfig, basePathOf, ConfigError, DEFAULT_SCOPES, type AuthallaOptions, type ResolvedConfig } from "./config.js";
export { OAuthError, type SignInParams } from "./oauth.js";
export { signInPath, type SignInOptions } from "./sign-in-path.js";
export { type Session, type SessionUser, type ClientSession } from "./session.js";
export { type RequestCookies, type RequestSession, type UserApiCall } from "./request-session.js";
export { parseCookieHeader, serializeCookie, type CookieJar, type CookieToSet, type CookieOptions } from "./cookies.js";
export {
  createUserApi,
  UserApiError,
  type UserApi,
  type UserApiTransport,
  type Me,
  type UserSession,
  type ConnectedApp,
  type ConnectedApps,
  type Passkey,
} from "./user-api.js";
