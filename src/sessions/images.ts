import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isException } from 'jg-exception';

import { MAX_ITEM_IMAGE_BYTES, type IItemImage } from '../contracts/index.js';

import { imageUnavailable, toItemImage } from './utilities.js';

/**
 * Reads an image file an item names. A file that is itself a symbolic link is refused, as the
 * open doesn't follow it, a pipe is never waited on, and only a regular file of at most 4 MiB is
 * read; a file that grew past 4 MiB since it was measured is refused.
 * @param path The file's absolute path.
 * @returns A promise that resolves to the image.
 * @throws
 * - JG_AGENT_HQ_IMAGE_UNAVAILABLE: The HQ image is unavailable
 */
export const readImageFile = async (path: string): Promise<IItemImage> => {
  if (!isAbsolute(path)) imageUnavailable();
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await file.stat();
      if (!stats.isFile() || stats.size > MAX_ITEM_IMAGE_BYTES) imageUnavailable();
      const bytes = Buffer.alloc(Math.min(stats.size, MAX_ITEM_IMAGE_BYTES) + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return toItemImage(bytes.subarray(0, length));
    } finally {
      await file.close();
    }
  } catch (error) {
    if (isException(error)) throw error;
    return imageUnavailable(error);
  }
};
