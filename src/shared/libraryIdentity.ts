import type { LibraryIdentity } from './ipc';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Shared public-field validation only; backend path binding remains private.
 * Check primitive types before matching, so arrays/objects are never coerced.
 */
export function validLibraryIdentity(value: unknown): value is LibraryIdentity {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1
    && typeof record.libraryId === 'string'
    && record.libraryId.length === 36
    && uuidV4.test(record.libraryId)
    && typeof record.epoch === 'number'
    && Number.isSafeInteger(record.epoch)
    && record.epoch >= 0;
}
