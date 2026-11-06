import { HttpError } from './http.mjs';

export const FREE_STORAGE_LIMIT = 9_000_000_000;

export function storageUsage(db, limit = FREE_STORAGE_LIMIT) {
  const rows = db.prepare('SELECT status, SUM(size) AS bytes FROM media GROUP BY status').all();
  const bytesFor = state => rows.find(row => row.status === state)?.bytes || 0;
  const ready = bytesFor('ready');
  const trash = bytesFor('trashed');
  const reserved = bytesFor('uploading');
  const total = ready + trash + reserved;
  return { ready, trash, reserved, total, limit, available: Math.max(0, limit - total) };
}

export function requireStorageCapacity(db, bytes, limit = FREE_STORAGE_LIMIT) {
  const usage = storageUsage(db, limit);
  if (usage.total + bytes > limit) {
    throw new HttpError(409, 'This would exceed the free-tier storage limit. Cancel an unfinished upload or permanently delete items from Trash.', {
      code: 'storage_limit', limit, available: usage.available
    });
  }
}
