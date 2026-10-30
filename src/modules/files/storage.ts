import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';

export interface FileStorage {
  put(key: string, data: Buffer, opts: { contentType: string }): Promise<void>;
  move(fromKey: string, toKey: string): Promise<void>;
  delete(key: string): Promise<void>;
  url(key: string): string;
}

export class LocalDiskStorage implements FileStorage {
  constructor(private rootDir: string, private publicBaseUrl: string) {}

  private resolvePath(key: string): string {
    return path.join(this.rootDir, key);
  }

  async put(key: string, data: Buffer, _opts: { contentType: string }): Promise<void> {
    const fullPath = this.resolvePath(key);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, data);
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const fromPath = this.resolvePath(fromKey);
    const toPath = this.resolvePath(toKey);
    await fs.mkdir(path.dirname(toPath), { recursive: true });
    await fs.rename(fromPath, toPath);
  }

  async delete(key: string): Promise<void> {
    const fullPath = this.resolvePath(key);
    try {
      await fs.unlink(fullPath);
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  url(key: string): string {
    return `${this.publicBaseUrl}/${key.replace(/^\/+/, '')}`;
  }
}

export class HttpFileServerStorage implements FileStorage {
  constructor(
    private serverUrl: string,
    private token: string,
    private publicBaseUrl: string
  ) {}

  async put(key: string, data: Buffer, opts: { contentType: string }): Promise<void> {
    const res = await fetch(`${this.serverUrl}/${key.replace(/^\/+/, '')}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': opts.contentType,
      },
      body: data,
    });
    if (!res.ok) {
      throw new Error(`HttpFileServerStorage.put failed: ${res.status} ${res.statusText}`);
    }
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/move`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: fromKey, to: toKey }),
    });
    if (!res.ok) {
      throw new Error(`HttpFileServerStorage.move failed: ${res.status} ${res.statusText}`);
    }
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/${key.replace(/^\/+/, '')}`, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${this.token}`,
      },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`HttpFileServerStorage.delete failed: ${res.status} ${res.statusText}`);
    }
  }

  url(key: string): string {
    return `${this.publicBaseUrl}/${key.replace(/^\/+/, '')}`;
  }
}

export function createStorage(): FileStorage {
  if (env.FILES_DRIVER === 'http' && env.FILES_SERVER_URL && env.FILES_TOKEN) {
    return new HttpFileServerStorage(
      env.FILES_SERVER_URL,
      env.FILES_TOKEN,
      env.FILES_PUBLIC_BASE_URL
    );
  }
  return new LocalDiskStorage(env.FILES_ROOT, env.FILES_PUBLIC_BASE_URL);
}

export const fileStorage = createStorage();
