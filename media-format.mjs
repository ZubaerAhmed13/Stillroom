import { HttpError } from './http.mjs';

export const MAX_FILE = 4 * 1024 ** 3;

export const formats = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm']
};

export function hasMediaSignature(bytes, mime) {
  const text = new TextDecoder('ascii').decode(bytes.subarray(0, 128));
  const starts = signature => bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
  switch (mime) {
    case 'image/jpeg': return starts([255, 216, 255]);
    case 'image/png': return starts([137, 80, 78, 71, 13, 10, 26, 10]);
    case 'image/webp': return text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
    case 'image/gif': return text.startsWith('GIF87a') || text.startsWith('GIF89a');
    case 'video/mp4': return text.slice(4, 8) === 'ftyp';
    case 'video/webm': return starts([26, 69, 223, 163]) && text.includes('webm');
    default: return false;
  }
}

export function uploadDetails(body) {
  const name = typeof body.name === 'string' ? body.name.replace(/[\x00-\x1f\x7f]/g, '').trim() : '';
  if (!name || name.length > 255 || /[/\\]/.test(name)) throw new HttpError(400, 'Enter a valid file name.');
  const ext = name.split('.').pop().toLowerCase();
  if (!Object.hasOwn(formats, body.mime) || !formats[body.mime].includes(ext)) {
    throw new HttpError(415, 'Choose a JPG, PNG, WebP, GIF, MP4 or WebM file.');
  }
  if (!Number.isSafeInteger(body.size) || body.size <= 0 || body.size > MAX_FILE) {
    throw new HttpError(400, 'Choose a file between 1 byte and 4 GiB.');
  }
  if (typeof body.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.fingerprint)) {
    throw new HttpError(400, 'The upload fingerprint is invalid.');
  }
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length > 120 || /[\x00-\x1f\x7f]/.test(title)) throw new HttpError(400, 'Use a title of up to 120 characters.');
  return { name, title: title || name.slice(0, -(ext.length + 1)).slice(0, 120) || name, mime: body.mime, size: body.size, fingerprint: body.fingerprint };
}

export function parseRange(header, size) {
  if (header === undefined) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (first === undefined) {
    if (!last) return null;
    return { start: Math.max(0, size - last), end: size - 1 };
  }
  if (first >= size || (last !== undefined && last < first)) return null;
  return { start: first, end: Math.min(size - 1, last ?? size - 1) };
}
