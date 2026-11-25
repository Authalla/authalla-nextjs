// Cookies as plain data, so each framework adapter writes them its own way:
// Set-Cookie headers on a Web Response, or Next.js's cookies().set().

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict";
  path: string;
  maxAge: number;
};

export type CookieToSet = { name: string; value: string; options: CookieOptions };

export type CookieJar = Map<string, string>;

// Browsers cap a cookie at about 4 KB, and three tokens sealed together can
// pass that, so a long value is split over name.0, name.1, …
const CHUNK_SIZE = 3800;

export function parseCookieHeader(header: string | null | undefined): CookieJar {
  const jar: CookieJar = new Map();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || jar.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      jar.set(name, decodeURIComponent(value));
    } catch {
      jar.set(name, value);
    }
  }
  return jar;
}

export function cookieName(base: string, secure: boolean): string {
  // __Host- makes the browser refuse the cookie unless it is Secure, for
  // Path=/ and without a Domain: no subdomain can plant or read it.
  return secure ? `__Host-${base}` : base;
}

export function readChunked(jar: CookieJar, name: string): string | undefined {
  if (jar.has(name)) return jar.get(name);
  let value = "";
  for (let i = 0; jar.has(`${name}.${i}`); i++) value += jar.get(`${name}.${i}`);
  return value || undefined;
}

function existingChunks(jar: CookieJar, name: string): string[] {
  return [...jar.keys()].filter((key) => key === name || (key.startsWith(`${name}.`) && /^\d+$/.test(key.slice(name.length + 1))));
}

// writeChunked sets value under name, and deletes whatever chunks of an
// earlier, longer value the request still carried.
export function writeChunked(jar: CookieJar, name: string, value: string, options: CookieOptions): CookieToSet[] {
  const out: CookieToSet[] = [];
  const written = new Set<string>();
  if (value.length <= CHUNK_SIZE) {
    out.push({ name, value, options });
    written.add(name);
  } else {
    for (let i = 0; i * CHUNK_SIZE < value.length; i++) {
      const chunk = `${name}.${i}`;
      out.push({ name: chunk, value: value.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE), options });
      written.add(chunk);
    }
  }
  for (const stale of existingChunks(jar, name)) {
    if (!written.has(stale)) out.push({ name: stale, value: "", options: { ...options, maxAge: 0 } });
  }
  return out;
}

export function deleteChunked(jar: CookieJar, name: string, options: CookieOptions): CookieToSet[] {
  return existingChunks(jar, name).map((chunk) => ({ name: chunk, value: "", options: { ...options, maxAge: 0 } }));
}

export function serializeCookie({ name, value, options }: CookieToSet): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path}`, `Max-Age=${options.maxAge}`];
  parts.push(`SameSite=${options.sameSite === "strict" ? "Strict" : "Lax"}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

// applyToJar gives the cookies as the next request will carry them, so a
// value set while handling a request is what the rest of it reads.
export function applyToJar(jar: CookieJar, cookies: CookieToSet[]): CookieJar {
  const next = new Map(jar);
  for (const cookie of cookies) {
    if (cookie.options.maxAge === 0) next.delete(cookie.name);
    else next.set(cookie.name, cookie.value);
  }
  return next;
}

export function jarToHeader(jar: CookieJar): string {
  return [...jar].map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("; ");
}
