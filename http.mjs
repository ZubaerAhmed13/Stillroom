export class HttpError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function json(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

export async function readBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw new HttpError(413, 'The request is too large.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    function cleanup() {
      request.off('data', onData).off('end', onEnd).off('error', onError).off('close', onClose);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        cleanup();
        request.resume();
        reject(new HttpError(413, 'The request is too large.'));
        return;
      }
      parts.push(chunk);
    }
    function onEnd() {
      cleanup();
      resolve(Buffer.concat(parts, size));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose() {
      onError(new HttpError(400, 'The upload was interrupted.'));
    }
    request.on('data', onData).once('end', onEnd).once('error', onError).once('close', onClose);
  });
}

export async function readJson(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'Expected JSON.');
  }
  const raw = await readBody(request, 16 * 1024);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'Expected a JSON object.');
  }
  return value;
}
