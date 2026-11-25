// Shared between the server and the browser bundle, so kept free of imports.

/** The query parameters that carry a failed sign-in back to the app. */
export const ERROR_PARAM = "authalla_error";
export const ERROR_DESCRIPTION_PARAM = "authalla_error_description";
/** Set to "passkey" when the request that failed was addPasskey(), not a sign-in. */
export const ERROR_PROMPT_PARAM = "authalla_error_prompt";
