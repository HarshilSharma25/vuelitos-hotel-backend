import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';

export class PrivateFileStorage {
  constructor(private rootDir: string) {}

  private resolvePath(key: string): string {
    const normalized = key.replace(/^\/+/, '').replace(/\.\./g, '');
    return path.join(this.rootDir, normalized);
  }

  async put(data: Buffer, opts: { ext: string }): Promise<string> {
    const key = `${crypto.randomUUID()}${opts.ext ? (opts.ext.startsWith('.') ? opts.ext : `.${opts.ext}`) : ''}`;
    const fullPath = this.resolvePath(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key));
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key));
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async scanHook(_key: string, _data: Buffer): Promise<boolean> {
    return true;
  }
}

let privateStorage: PrivateFileStorage | null = null;

export function getPrivateFileStorage(): PrivateFileStorage {
  if (!privateStorage) {
    privateStorage = new PrivateFileStorage(env.PRIVATE_FILES_DIR);
  }
  return privateStorage;
}
