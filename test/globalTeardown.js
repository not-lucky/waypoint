import fsp from 'node:fs/promises';
import path from 'node:path';

export default async () => {
  await fsp.rm(path.resolve('test/.tmp'), { recursive: true, force: true }).catch(() => {});
};
