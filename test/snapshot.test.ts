import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageSnapshot, projectDetails, removeSnapshot, selectFiles } from '../src/snapshot.js';

const temporary: string[] = [];
async function fixture(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'docuwriter-test-')));
  temporary.push(path);
  return path;
}
async function file(root: string, path: string, content = 'source'): Promise<void> {
  const target = join(root, path);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content);
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('snapshot selection', () => {
  it('keeps the exact subdirectory, local edits and untracked files while applying ancestor and nested ignores', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await file(root, '.gitignore', '*.log\nignored/\n');
    await file(root, 'outside.ts');
    await file(root, 'packages/api/main.ts', 'local edit');
    await file(root, 'packages/api/new.ts', 'untracked source');
    await file(root, 'packages/api/debug.log');
    await file(root, 'packages/api/ignored/source.ts');
    await file(root, 'packages/api/nested/.gitignore', '*.txt\n!keep.txt\n');
    await file(root, 'packages/api/nested/remove.txt');
    await file(root, 'packages/api/nested/keep.txt');
    const selected = await selectFiles(join(root, 'packages/api'), [], 10_000);
    expect(selected.files.map(file => file.name)).toEqual(['main.ts', 'nested/.gitignore', 'nested/keep.txt', 'new.ts']);
    expect(await readFile(selected.files[0].absolute, 'utf8')).toBe('local edit');
    expect((await projectDetails(join(root, 'packages/api'))).folder).toBe(join(root, 'packages/api'));
  });
  it('does not upload symlinks, secrets, dependencies or server exclusions', async () => {
    const root = await fixture();
    await file(root, 'src/main.ts');
    for (const name of ['.env', '.env.production', '.npmrc', 'config/cert.pem', '.aws/credentials', 'node_modules/pkg/file.js', 'vendor/lib/file.php', 'custom/cache.txt']) await file(root, name, 'secret');
    await symlink(join(root, '.env'), join(root, 'linked.ts'));
    await symlink(join(root, 'src'), join(root, 'linked-directory'));
    const selected = await selectFiles(root, ['custom/', '!.env'], 10_000);
    expect(selected.files.map(file => file.name)).toEqual(['src/main.ts']);
    expect(selected.excluded).toBeGreaterThan(5);
  });
  it('rejects an ignored selected folder and empty or oversized snapshots', async () => {
    const root = await fixture();
    await mkdir(join(root, '.git'));
    await file(root, '.gitignore', 'ignored/');
    await file(root, 'ignored/main.ts');
    await expect(selectFiles(join(root, 'ignored'), [], 10_000)).rejects.toThrow('excluded');
    const empty = await fixture();
    await expect(selectFiles(empty, [], 10_000)).rejects.toThrow('No uploadable');
    await file(empty, 'big.ts', '1234567890');
    await expect(selectFiles(empty, [], 5)).rejects.toThrow('limit');
  });
  it('packages one wrapper root privately and removes temporary data', async () => {
    const root = await fixture();
    const state = await fixture();
    await file(root, 'src/main.ts', 'hello world');
    const selected = await selectFiles(root, [], 10_000);
    const snapshot = await packageSnapshot(selected, state);
    if (process.platform !== 'win32') expect((await stat(snapshot.archive)).mode & 0o777).toBe(0o600);
    const bytes = await readFile(snapshot.archive);
    expect(bytes.includes(Buffer.from('project/src/main.ts'))).toBe(true);
    await removeSnapshot(snapshot.archive, state);
    await expect(stat(snapshot.archive)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeSnapshot('/tmp/snapshot-unsafe/source.zip', state)).rejects.toThrow('Unsafe');
  });
  it('fails instead of packaging files replaced by symlinks after selection', async () => {
    const root = await fixture();
    const state = await fixture();
    await file(root, 'main.ts');
    await file(state, 'secret.txt');
    const selected = await selectFiles(root, [], 10_000);
    await rm(join(root, 'main.ts'));
    await symlink(join(state, 'secret.txt'), join(root, 'main.ts'));
    await expect(packageSnapshot(selected, state)).rejects.toThrow('changed');
  });
});
