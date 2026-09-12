import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, copyFile, link, lstat, mkdir, unlink } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';

export async function storeObject(config, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Evidence file path is required');
  }

  const temporary = join(config.stagingDir, `${randomUUID()}.tmp`);
  try {
    await copyFile(filePath, temporary, constants.COPYFILE_EXCL);
    await chmod(temporary, 0o600);
    const details = await lstat(temporary);
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error(`Evidence path is not a regular file: ${filePath}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(temporary)) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const relativeDirectory = posix.join('objects', sha256.slice(0, 2));
    const objectPath = posix.join(relativeDirectory, sha256.slice(2));
    const destinationDirectory = join(config.dataDir, relativeDirectory);
    const destination = join(config.dataDir, objectPath);
    await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    return {
      sha256,
      byteSize: details.size,
      objectPath,
      originalFilename: basename(filePath),
    };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
