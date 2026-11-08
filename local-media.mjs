import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export { formats, hasMediaSignature, parseRange } from './media-format.mjs';

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
