import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function applicationDirectory(): string {
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'DocuWriter');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'DocuWriter');
  return join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'docuwriter');
}

export class Storage {
  readonly directory: string;
  constructor(origin: string, base = applicationDirectory()) {
    this.directory = join(base, createHash('sha256').update(origin).digest('hex').slice(0, 20));
  }
  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The DocuWriter data directory is unsafe.');
    await chmod(this.directory, 0o700);
  }
  async read<T>(name: string): Promise<T | null> {
    try {
      const path = join(this.directory, `${name}.json`);
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Unsafe saved CLI state.');
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(name: string, value: unknown): Promise<void> {
    await this.initialize();
    const temporary = join(this.directory, `.${randomUUID()}.json`);
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(this.directory, `${name}.json`));
  }
  async remove(name: string): Promise<void> {
    await rm(join(this.directory, `${name}.json`), { force: true });
  }
}
