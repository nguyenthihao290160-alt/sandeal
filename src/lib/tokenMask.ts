// ===========================================
// Token Masking Utility
// ===========================================

/**
 * Mask a token/key for safe display.
 * Shows first 4 and last 4 characters, masks middle.
 * Example: "EAABcd12345xyz9abc" → "EAAB****9abc"
 */
export function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 8) return '****';
  const prefix = token.slice(0, 4);
  const suffix = token.slice(-4);
  return `${prefix}****${suffix}`;
}

/**
 * Mask an email for safe display.
 * Example: "admin@example.com" → "adm***@example.com"
 */
export function maskEmail(email: string): string {
  if (!email || !email.includes('@')) return '****';
  const [local, domain] = email.split('@');
  if (local.length <= 3) return `${local[0]}***@${domain}`;
  return `${local.slice(0, 3)}***@${domain}`;
}

/**
 * Check if a value looks like a real token (not empty/placeholder).
 */
export function isTokenProvided(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed !== 'your-key-here' && trimmed !== 'change-me';
}
