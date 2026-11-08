import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { hasMediaSignature, parseRange, MAX_FILE, uploadDetails } from './media-format.mjs';
import { HttpError, readBody } from './http.mjs';
import { atomic, listCollections } from './catalog.mjs';
import { FREE_STORAGE_LIMIT, requireStorageCapacity, storageUsage } from './storage-budget.mjs';

export { MAX_FILE } from './media-format.mjs';
export const MEDIA_ID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const LINK_DURATION = 15 * 60 * 1000;

export function describe(item, owner = false) {
  return {
    id: item.id, title: item.title, name: item.name, mime: item.mime, size: item.size,
    kind: item.mime.startsWith('video/') ? 'video' : 'photo', created: item.created,
    description: item.description, collectionId: item.collection_id,
    ...(owner ? { favourite: Boolean(item.favourite) } : {})
  };
}

export function collectionName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new HttpError(400, 'Enter a collection name of up to 80 characters.');
  }
  return name;
}

export function openMedia(db, blobs, { chunkSize, now, storageLimit = FREE_STORAGE_LIMIT }) {
  if (!Number.isSafeInteger(storageLimit) || storageLimit < 1 || storageLimit > FREE_STORAGE_LIMIT) {
    throw new RangeError('Storage limit must be between 1 byte and 9 GB.');
  }
  const signingKey = randomBytes(32);
  const busy = new Set();
  const find = db.prepare('SELECT * FROM media WHERE id = ?');
  const findCollection = db.prepare('SELECT id, name FROM collections WHERE id = ?');
  const deleteRow = db.prepare('DELETE FROM media WHERE id = ?');
  const setStatus = db.prepare('UPDATE media SET status = ?, version = version + 1 WHERE id = ?');

  function findStatus(id, statuses) {
    const item = find.get(id);
    if (!item || !statuses.includes(item.status)) throw new HttpError(404, 'Media item not found.');
    return item;
  }

  async function lock(id, work) {
    if (busy.has(id)) throw new HttpError(409, 'Another request is updating this file.');
    busy.add(id);
    try {
      return await work();
    } finally {
      busy.delete(id);
    }
  }

  function sign(item, user, expires) {
    return createHmac('sha256', signingKey)
      .update([item.id, item.version, user.session, expires].join(':')).digest('base64url');
  }

  function ownerList(status) {
    return db.prepare('SELECT * FROM media WHERE status = ? ORDER BY created DESC, id DESC').all(status);
  }

  return {
    list(owner) {
      return { items: ownerList('ready').map(item => describe(item, owner)), collections: listCollections(db) };
    },
    saveCollection(body, id) {
      const name = collectionName(body.name);
      return atomic(db, () => {
        if (id && !findCollection.get(id)) throw new HttpError(404, 'Collection not found.');
        const existing = db.prepare('SELECT id FROM collections WHERE name = ?').get(name);
        if (existing && existing.id !== id) throw new HttpError(409, 'A collection already has that name.');
        if (id) {
          db.prepare('UPDATE collections SET name = ? WHERE id = ?').run(name, id);
        } else {
          id = randomUUID();
          db.prepare('INSERT INTO collections (id, name) VALUES (?, ?)').run(id, name);
        }
        return { id, name };
      });
    },
    edit(id, body) {
      return atomic(db, () => {
        const item = findStatus(id, ['ready']);
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (body.title !== undefined && (!title || title.length > 120 || /[\x00-\x1f\x7f]/.test(title))) {
          throw new HttpError(400, 'Enter a title of up to 120 characters.');
        }
        const description = body.description === undefined ? item.description : body.description;
        if (typeof description !== 'string' || description.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(description)) {
          throw new HttpError(400, 'Use a description of up to 2,000 characters.');
        }
        const collectionId = body.collectionId === undefined ? item.collection_id : body.collectionId;
        if (body.collectionId !== undefined && collectionId !== null) {
          if (typeof collectionId !== 'string' || !MEDIA_ID.test(collectionId)) throw new HttpError(400, 'Choose a valid collection.');
          if (!findCollection.get(collectionId)) throw new HttpError(404, 'Collection not found.');
        }
        if (body.favourite !== undefined && typeof body.favourite !== 'boolean') throw new HttpError(400, 'Invalid favourite setting.');
        const favourite = body.favourite === undefined ? item.favourite : Number(body.favourite);
        db.prepare('UPDATE media SET title = ?, description = ?, collection_id = ?, favourite = ? WHERE id = ?')
          .run(body.title === undefined ? item.title : title, description.trim(), collectionId, favourite, id);
        return describe(find.get(id), true);
      });
    },
    trash() {
      return ownerList('trashed').map(item => describe(item));
    },
    async pending() {
      return Promise.all(ownerList('uploading').map(async item => ({
        ...describe(item), offset: await blobs.size(item.id)
      })));
    },
    usage() {
      return storageUsage(db, storageLimit);
    },
    async start(body) {
      const { name, title, mime, size, fingerprint } = uploadDetails(body);
      const reservation = atomic(db, () => {
        const previous = db.prepare(`SELECT * FROM media WHERE fingerprint = ? AND size = ? AND name = ? AND mime = ?
          AND status IN ('uploading','ready') ORDER BY created DESC LIMIT 1`).get(fingerprint, size, name, mime);
        if (previous) return { id: previous.id, created: false, complete: previous.status === 'ready' };
        if (db.prepare("SELECT COUNT(*) AS count FROM media WHERE status = 'uploading'").get().count >= 12) {
          throw new HttpError(409, 'Finish or cancel an interrupted upload before starting another.');
        }
        requireStorageCapacity(db, size, storageLimit);
        const id = randomUUID();
        db.prepare(`INSERT INTO media (id, title, name, mime, size, fingerprint, status, created)
          VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?)`).run(id, title, name, mime, size, fingerprint, now());
        return { id, created: true, complete: false };
      });
      const offset = reservation.complete ? size : reservation.created ? 0 : await blobs.size(reservation.id);
      return { ...reservation, offset, chunkSize };
    },
    async chunk(request, id, suppliedOffset) {
      if (!/^\d+$/.test(suppliedOffset ?? '') || !Number.isSafeInteger(Number(suppliedOffset))) {
        throw new HttpError(400, 'An upload offset is required.');
      }
      if (request.headers['content-type'] !== 'application/octet-stream') {
        throw new HttpError(415, 'Expected binary upload data.');
      }
      return lock(id, async () => {
        const item = findStatus(id, ['uploading']);
        requireStorageCapacity(db, 0, storageLimit);
        const offset = await blobs.size(id);
        if (Number(suppliedOffset) !== offset) throw new HttpError(409, 'Upload offset changed.', { offset });
        const expected = Math.min(chunkSize, item.size - offset);
        if (expected <= 0) throw new HttpError(409, 'This upload is ready to finish.', { offset });
        const bytes = await readBody(request, expected);
        if (bytes.length !== expected) throw new HttpError(400, 'The upload part is incomplete.');
        await blobs.append(id, bytes);
        return { offset: offset + bytes.length };
      });
    },
    async finish(id) {
      return lock(id, async () => {
        const item = findStatus(id, ['uploading', 'ready']);
        if (item.status === 'ready') return describe(item);
        if (await blobs.size(id) !== item.size) throw new HttpError(409, 'This upload is incomplete.');
        if (!hasMediaSignature(await blobs.signature(id), item.mime)) {
          await blobs.remove(id);
          deleteRow.run(id);
          throw new HttpError(415, 'The file contents do not match the selected format.');
        }
        setStatus.run('ready', id);
        return describe(item);
      });
    },
    async discard(id, status) {
      return lock(id, async () => {
        findStatus(id, [status]);
        await blobs.remove(id);
        deleteRow.run(id);
      });
    },
    async move(id, from, to) {
      return lock(id, async () => {
        const item = findStatus(id, [from]);
        if (to === 'ready' && await blobs.size(id) !== item.size) {
          throw new HttpError(409, 'The original file is missing. Restore it from a backup.');
        }
        setStatus.run(to, id);
      });
    },
    link(id, user) {
      const item = findStatus(id, ['ready']);
      const expires = now() + LINK_DURATION;
      return { url: '/api/media/' + id + '/content?expires=' + expires + '&token=' + sign(item, user, expires), expires };
    },
    async content(request, response, id, user, params) {
      const item = findStatus(id, ['ready']);
      const expires = Number(params.get('expires'));
      const token = params.get('token') || '';
      if (!Number.isSafeInteger(expires) || expires <= now() || !/^[\w-]{43}$/.test(token) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(sign(item, user, expires)))) {
        throw new HttpError(403, 'This media link is invalid or has expired.');
      }
      if (await blobs.size(id) !== item.size) throw new HttpError(404, 'The media file is unavailable.');
      const range = parseRange(request.headers.range, item.size);
      response.setHeader('accept-ranges', 'bytes');
      if (!range) {
        response.writeHead(416, { 'content-range': 'bytes */' + item.size });
        response.end();
        return;
      }
      response.setHeader('content-type', item.mime);
      response.setHeader('content-length', range.end - range.start + 1);
      if (request.headers.range) response.setHeader('content-range', 'bytes ' + range.start + '-' + range.end + '/' + item.size);
      response.writeHead(request.headers.range ? 206 : 200);
      if (request.method === 'HEAD') return response.end();
      try {
        await pipeline(blobs.read(id, range), response);
      } catch (error) {
        if (!['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code)) throw error;
      }
    }
  };
}
