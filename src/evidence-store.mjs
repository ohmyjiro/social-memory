import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';

export async function storeObject(config, filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('Evidence file path is required');
  }

  const details = await stat(filePath);
  if (!details.isFile()) throw new Error(`Evidence path is not a regular file: ${filePath}`);

  const bytes = await readFile(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const relativeDirectory = posix.join('objects', sha256.slice(0, 2));
  const objectPath = posix.join(relativeDirectory, sha256.slice(2));
  const destinationDirectory = join(config.dataDir, relativeDirectory);
  const destination = join(config.dataDir, objectPath);
  const temporary = join(config.stagingDir, `${sha256}-${randomUUID()}.tmp`);

  await mkdir(destinationDirectory, { recursive: true, mode: 0o700 });
  try {
    await copyFile(filePath, temporary, constants.COPYFILE_EXCL);
    await link(temporary, destination);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }

  return {
    sha256,
    byteSize: details.size,
    objectPath,
    originalFilename: basename(filePath),
  };
}
