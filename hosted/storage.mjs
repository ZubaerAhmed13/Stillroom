import { HttpError } from '../http.mjs';
import { hasMediaSignature, parseRange, uploadDetails } from '../media-format.mjs';

const partSize = 8 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

async function uploadPartBytes(request) {
  if (request.headers.get('content-type') !== 'application/octet-stream') {
    throw new HttpError(415, 'Expected an upload part.');
  }
  if (Number(request.headers.get('content-length')) > partSize) throw new HttpError(413, 'This upload part is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'The upload part is empty.');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > partSize) {
        await reader.cancel();
        throw new HttpError(413, 'This upload part is too large.');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new HttpError(400, 'The upload part is empty.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

async function writePart(request, url, bucket, key, id, call) {
  const offset = Number(url.searchParams.get('offset'));
  if (!/^\d+$/.test(url.searchParams.get('offset') ?? '') || !Number.isSafeInteger(offset)) {
    throw new HttpError(400, 'An upload offset is required.');
  }
  await call('require_owner');
  const bytes = await uploadPartBytes(request);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
    byte => byte.toString(16).padStart(2, '0')).join('');
  const lease = crypto.randomUUID();
  const requestPart = await call('storage_part', { id, lease, offset, length: bytes.byteLength, hash });
  if (requestPart.alreadySaved) return { offset: requestPart.offset };
  if (offset === 0 && !hasMediaSignature(bytes, requestPart.mime)) {
    await call('storage_reject_part', { id, lease });
    throw new HttpError(415, 'The file contents do not match the selected format.');
  }
  let multipart;
  if (requestPart.uploadId) {
    multipart = bucket.resumeMultipartUpload(key, requestPart.uploadId);
  } else {
    multipart = await bucket.createMultipartUpload(key, { storageClass: 'Standard', httpMetadata: { contentType: requestPart.mime } });
    // An unrecorded multipart creation has no parts, so it stores no media bytes.
    await call('storage_save_multipart', { id, lease, uploadId: multipart.uploadId });
  }
  const { etag } = await multipart.uploadPart(requestPart.partNumber, bytes);
  return call('storage_save_part', { id, lease, etag });
}

async function finishUpload(bucket, key, id, call) {
  const lease = crypto.randomUUID();
  const upload = await call('storage_finish', { id, lease });
  if (upload.complete) return upload.item;
  let object = await bucket.head(key);
  if (!object) {
    try {
      await call('storage_complete_budget', { id, lease });
    } catch (error) {
      if (error.status === 429) await call('storage_release', { id, lease });
      throw error;
    }
    object = await bucket.resumeMultipartUpload(key, upload.uploadId).complete(upload.parts);
  }
  if (object.size !== upload.size) throw new HttpError(503, 'The uploaded file could not be verified.');
  return call('storage_publish', { id, lease });
}

async function removeUpload(bucket, key, id, call, status) {
  const lease = crypto.randomUUID();
  const upload = await call('storage_remove', { id, lease, status });
  if (upload.removed) return;
  if (upload.uploadId) {
    try {
      await bucket.resumeMultipartUpload(key, upload.uploadId).abort();
    } catch (error) {
      // R2 10024 confirms this multipart ID can no longer accept parts or complete.
      if (!/\(10024\)$/.test(error?.message || '')) throw error;
    }
  }
  await bucket.delete(key);
  await call('storage_removed', { id, lease });
}

async function readMedia(request, bucket, key, id, call, headers) {
  const item = await call('storage_read', { id });
  const supplied = request.headers.get('range') ?? undefined;
  const range = parseRange(supplied, item.size);
  const base = { ...headers, 'accept-ranges': 'bytes' };
  if (!range) return new Response(null, { status: 416, headers: { ...base, 'content-range': 'bytes */' + item.size } });
  const length = range.end - range.start + 1;
  const object = request.method === 'HEAD' ? await bucket.head(key) :
    await bucket.get(key, supplied === undefined ? undefined : { range: { offset: range.start, length } });
  if (!object || object.size !== item.size) {
    await object?.body?.cancel();
    throw new HttpError(404, 'The media file is unavailable.');
  }
  const resultHeaders = { ...base, 'content-type': item.mime, 'content-length': String(length) };
  if (supplied !== undefined) resultHeaders['content-range'] = 'bytes ' + range.start + '-' + range.end + '/' + item.size;
  let body = request.method === 'HEAD' ? null : object.body;
  if (body && typeof globalThis.FixedLengthStream === 'function') {
    body = body.pipeThrough(new globalThis.FixedLengthStream(length));
  }
  return new Response(body, {
    status: supplied === undefined ? 200 : 206, headers: resultHeaders
  });
}

export async function serveStorage(request, url, bucket, call, { readData, json, headers }) {
  const { pathname } = url;
  const { method } = request;
  if (pathname === '/api/uploads' && method === 'POST') {
    const details = uploadDetails(await readData(request));
    const { created, ...result } = await call('storage_reserve', details);
    return json({ ...result, chunkSize: partSize }, created ? 201 : 200);
  }
  const match = /^\/api\/(uploads|media)\/([^/]+)(?:\/([^/]+))?$/.exec(pathname);
  if (!match || !uuid.test(match[2])) throw new HttpError(404, 'Page not found.');
  const [, resource, id, operation] = match;
  const key = 'media/' + id;
  if (resource === 'uploads') {
    if (method === 'PUT' && !operation) return json(await writePart(request, url, bucket, key, id, call));
    if (method === 'POST' && operation === 'finish') return json(await finishUpload(bucket, key, id, call));
    if (method === 'DELETE' && !operation) {
      await removeUpload(bucket, key, id, call, 'uploading');
      return json({});
    }
  } else {
    if (method === 'GET' && operation === 'link') {
      await call('storage_lookup', { id });
      return json({ url: pathname.slice(0, -4) + 'content' });
    }
    if (['GET', 'HEAD'].includes(method) && operation === 'content') return readMedia(request, bucket, key, id, call, headers);
    if (method === 'DELETE' && !operation) return json(await call('storage_trash', { id }));
    if (method === 'POST' && operation === 'restore') return json(await call('storage_restore', { id }));
    if (method === 'DELETE' && operation === 'purge') {
      await removeUpload(bucket, key, id, call, 'trashed');
      return json({});
    }
  }
  throw new HttpError(404, 'Page not found.');
}
