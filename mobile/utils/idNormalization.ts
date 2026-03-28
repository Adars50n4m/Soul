// mobile/utils/idNormalization.ts

export const LEGACY_TO_UUID: Record<string, string> = {
  'shri': 'f00f00f0-0000-0000-0000-000000000002',
  'hari': 'f00f00f0-0000-0000-0000-000000000001',
};

export const UUID_TO_LEGACY: Record<string, string> = Object.entries(LEGACY_TO_UUID).reduce(
  (acc, [legacy, uuid]) => ({ ...acc, [uuid]: legacy }),
  {}
);

/**
 * Normalizes any user ID to its canonical UUID.
 * 
 * If the input is a legacy ID ('shri', 'hari'), it returns the hardcoded UUID.
 * Otherwise, it returns the input as is.
 */
export function normalizeId(id: string | null | undefined): string {
  if (!id) return '';
  const trimmed = id.trim().toLowerCase();
  return LEGACY_TO_UUID[trimmed] || id;
}

/**
 * Checks if an ID is a legacy ID.
 */
export function isLegacyId(id: string): boolean {
  return LEGACY_TO_UUID[id.toLowerCase()] !== undefined;
}

/**
 * Resolves a display name for a given ID if it's a superuser.
 */
export function getSuperuserName(id: string): string | null {
  const normalized = normalizeId(id);
  if (normalized === LEGACY_TO_UUID['shri']) return 'Shri';
  if (normalized === LEGACY_TO_UUID['hari']) return 'Hari';
  return null;
}

/**
 * Checks if a message is within the allowed 5-minute window for edits/deletes.
 * 300,000 ms = 5 minutes.
 */
export function isWithinEditWindow(timestamp: string): boolean {
  if (!timestamp) return false;
  const now = new Date().getTime();
  const sentAt = new Date(timestamp).getTime();
  return (now - sentAt) < 300000;
}
