// Sealing: the session and the pending sign-in live in cookies, encrypted
// and authenticated with AES-256-GCM so the browser can neither read the
// tokens nor change them. Web Crypto only, so it runs on Node, Bun, Deno and
// edge runtimes alike.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

// The key is derived from the secret with HKDF rather than used as-is, so a
// secret of any length and alphabet gives a full-strength key.
function keyFor(secret: string): Promise<CryptoKey> {
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle
      .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
      .then((material) =>
        crypto.subtle.deriveKey(
          { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("authalla-nextjs cookie v1") },
          material,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
      );
    keys.set(secret, key);
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// purpose is bound into the ciphertext as additional data: a sealed pending
// sign-in can't be passed off as a session, or the other way round.
export async function seal(value: unknown, secret: string, purpose: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(purpose) },
      await keyFor(secret),
      encoder.encode(JSON.stringify(value)),
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv);
  out.set(ciphertext, iv.length);
  return toBase64Url(out);
}

// unseal returns undefined for anything it can't open: tampered, sealed with
// another secret or for another purpose, or not a sealed value at all.
export async function unseal<T>(sealed: string, secret: string, purpose: string): Promise<T | undefined> {
  try {
    const bytes = fromBase64Url(sealed);
    if (bytes.length < 13) return undefined;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: encoder.encode(purpose) },
      await keyFor(secret),
      bytes.subarray(12),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    return undefined;
  }
}

export function randomString(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Base64Url(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

// decodeJwtPayload reads a JWT's claims without checking its signature; see
// readIdToken for why that is enough for tokens from the token endpoint.
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const claims = JSON.parse(decoder.decode(fromBase64Url(parts[1])));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? claims : undefined;
  } catch {
    return undefined;
  }
}
