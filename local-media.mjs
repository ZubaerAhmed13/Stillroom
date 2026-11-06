import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const formats = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'video/mp4': ['mp4', 'm4v'],
  'video/webm': ['webm']
};

export function hasMediaSignature(bytes, mime) {
  const text = bytes.toString('ascii');
  switch (mime) {
    case 'image/jpeg': return bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    case 'image/png': return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/webp': return text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP';
    case 'image/gif': return text.startsWith('GIF87a') || text.startsWith('GIF89a');
    case 'video/mp4': return text.slice(4, 8) === 'ftyp';
    case 'video/webm': return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])) && text.includes('webm');
    default: return false;
  }
}

export async function openLocalMedia(dataDir) {
  const directory = join(dataDir, 'media');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const pathFor = id => join(directory, id);
  return {
    async size(id) {
      try {
        return (await stat(pathFor(id))).size;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return 0;
      }
    },
    append(id, bytes) {
      return appendFile(pathFor(id), bytes, { mode: 0o600, flush: true });
    },
    async signature(id) {
      const file = await open(pathFor(id), 'r');
      try {
        const bytes = Buffer.alloc(128);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        return bytes.subarray(0, bytesRead);
      } finally {
        await file.close();
      }
    },
    async remove(id) {
      try {
        await unlink(pathFor(id));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    },
    read(id, range) {
      return createReadStream(pathFor(id), range);
    }
  };
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
