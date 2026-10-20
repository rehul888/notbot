// Owner-uploaded images (logo, welcome banner) kept in D1 and served from /media/<kind>.
import { LIMITS } from "../shared/brand";
import type { Env } from "./env";
import { getSettings, setSettingsStmts, type Settings } from "./settings";

export type AssetKind = "logo" | "banner";
export const isAssetKind = (v: string): v is AssetKind => v === "logo" || v === "banner";
export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Real type from the first bytes (the Content-Type header is never trusted). PNG, JPEG and WebP only; no SVG. */
export function detectImageMime(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  const tag = (o: number, t: string) => [...t].every((c, i) => b[o + i] === c.charCodeAt(0));
  if (b.length >= 12 && tag(0, "RIFF") && tag(8, "WEBP")) return "image/webp";
  return null;
}

/** Why an upload is refused, or null if it is a fine image of the declared type */
export function checkImageUpload(contentType: string | undefined | null, bytes: Uint8Array): "EMPTY" | "TOO_LARGE" | "INVALID_IMAGE" | null {
  if (!bytes.length) return "EMPTY";
  if (bytes.length > LIMITS.imageBytes) return "TOO_LARGE";
  const declared = (contentType ?? "").split(";")[0].trim().toLowerCase();
  const real = detectImageMime(bytes);
  return real && declared === real ? null : "INVALID_IMAGE";
}

const CHUNK = 0x2000;
export function bytesToBase64(bytes: Uint8Array): string {
  // Native encoder when the runtime has it (fast enough for the free plan's CPU limit); chunked fallback otherwise
  const native = (bytes as unknown as { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let bin = "";
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (native) return native.call(Uint8Array, b64);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Statements that store (or replace) an image and bump its cache version. A new banner drops the cached Telegram file. */
export function putAssetStmts(env: Env, s: Settings, kind: AssetKind, mime: ImageMime, bytes: Uint8Array): D1PreparedStatement[] {
  const now = Math.floor(Date.now() / 1000);
  const verKey = kind === "logo" ? "logo_ver" : "banner_ver";
  const ver = Math.abs(s[verKey]) + 1;
  return [
    env.DB.prepare(
      "INSERT INTO assets (kind, mime, data, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at",
    ).bind(kind, mime, bytesToBase64(bytes), now),
    ...setSettingsStmts(env, { [verKey]: ver, ...(kind === "banner" ? { welcome_photo: "" } : {}) }),
  ];
}

export function deleteAssetStmts(env: Env, s: Settings, kind: AssetKind): D1PreparedStatement[] {
  const verKey = kind === "logo" ? "logo_ver" : "banner_ver";
  return [
    env.DB.prepare("DELETE FROM assets WHERE kind = ?1").bind(kind),
    // A negative version means "removed" and keeps counting up if another image is uploaded later
    ...setSettingsStmts(env, { [verKey]: -Math.abs(s[verKey]), ...(kind === "banner" ? { welcome_photo: "" } : {}) }),
  ];
}

/** The public image response (headers fixed by the open-source plan: the file can never run as a page or script) */
export async function mediaResponse(env: Env, kind: string, version?: string | null): Promise<Response> {
  if (!isAssetKind(kind)) return new Response("Not found", { status: 404 });
  // Links carry ?v=<version>: the current version never changes, so browsers and Telegram can keep it for a year
  const s = await getSettings(env);
  const current = String(kind === "logo" ? s.logo_ver : s.banner_ver);
  const immutable = !!version && version === current && Number(current) > 0;
  const row = await env.DB.prepare("SELECT mime, data FROM assets WHERE kind = ?1").bind(kind).first<{ mime: string; data: string }>();
  if (!row || !["image/png", "image/jpeg", "image/webp"].includes(row.mime)) return new Response("Not found", { status: 404 });
  return new Response(base64ToBytes(row.data), {
    headers: {
      "content-type": row.mime,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "public, max-age=300",
    },
  });
}
