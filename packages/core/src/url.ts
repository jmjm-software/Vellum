/**
 * URL safety (architecture §10: no arbitrary action URLs, no executable
 * expressions). Agent-authored links are untrusted input, so only plain
 * http(s) targets without embedded credentials are accepted; the schemes that
 * can execute code or exfiltrate (javascript:, data:, file:, intent:, blob:)
 * are rejected at validation time — in the catalogue schema, in design
 * validation, and again by every client before opening anything.
 */

const MAX_URL_LENGTH = 2000;

export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  // Control characters / whitespace tricks (e.g. "java\nscript:").
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (url.username || url.password) return false; // credentials in URLs are a phishing vector
  return url.hostname.length > 0;
}

/** Normalized href for storage/rendering (drops nothing meaningful, keeps it canonical). */
export function normalizeHref(value: string): string {
  return new URL(value).toString();
}
