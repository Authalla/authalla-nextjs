// The framework-free core: OAuth, the sealed session cookie and the User API
// on Web-standard Request and Response. Adapters for other frameworks build
// on this; Next.js apps use the package's main entry instead.
export { createCore, safeReturnTo, type AuthallaCore } from "./handler.js";
export { ERROR_PARAM, ERROR_DESCRIPTION_PARAM } from "./constants.js";
export { resolveConfig, ConfigError, DEFAULT_SCOPES, type AuthallaOptions, type ResolvedConfig } from "./config.js";
export { OAuthError, type SignInParams } from "./oauth.js";
export { toSession, toClientSession, isEnded, type Session, type SessionUser, type ClientSession, type StoredSession } from "./session.js";
export { serializeCookie, jarToHeader, type CookieToSet, type CookieOptions } from "./cookies.js";
export {
  createUserApi,
  directTransport,
  UserApiError,
  type UserApi,
  type UserApiTransport,
  type Me,
  type UserSession,
  type ConnectedApp,
  type ConnectedApps,
  type Passkey,
} from "./user-api.js";
