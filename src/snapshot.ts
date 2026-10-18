import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ZipArchive } from 'archiver';
import { once } from 'node:events';
import ignore, { type Ignore } from 'ignore';

const execute = promisify(execFile);
const slash = (path: string): string => path.split(sep).join('/');
const inside = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};
export const requiredExclusions = [
  '.git/', '.hg/', '.svn/', 'node_modules/', 'vendor/', '.venv/', 'venv/', '__pycache__/',
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore', 'id_rsa*', 'id_ed25519*',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.aws/', '.ssh/', '.kube/', '.docker/',
  'credentials.json', 'credentials.*.json', '*service-account*.json', 'serviceAccount*.json', '*.jks',
  '.DS_Store', '.terraform/', '*.tfstate', '*.tfstate.*',
];
interface Matcher { directory: string; rules: Ignore }
export interface SelectedFile { absolute: string; name: string; size: number }
export interface Selection { folder: string; files: SelectedFile[]; excluded: number; bytes: number }

export async function projectDetails(folder: string): Promise<{ folder: string; name: string; repository?: string; branch?: string }> {
  const selected = await realpath(resolve(folder));
  if (!(await stat(selected)).isDirectory()) throw new Error('Select a project directory.');
  const result = { folder: selected, name: basename(selected) } as { folder: string; name: string; repository?: string; branch?: string };
  try {
    const root = await execute('git', ['-C', selected, 'rev-parse', '--show-toplevel']);
    result.repository = basename(root.stdout.trim());
    const branch = await execute('git', ['-C', selected, 'branch', '--show-current']);
    result.branch = branch.stdout.trim() || 'detached HEAD';
  } catch { /* Non-Git projects are supported. */ }
  return result;
}

async function matcher(directory: string): Promise<Matcher | null> {
  try {
    const path = join(directory, '.gitignore');
    if ((await lstat(path)).isSymbolicLink()) return null;
    return { directory, rules: ignore().add(await readFile(path, 'utf8')) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function selectFiles(folder: string, patterns: string[], maximumBytes: number, signal?: AbortSignal): Promise<Selection> {
  const selected = await realpath(folder);
  const mandatory = ignore().add(requiredExclusions);
  const excluded = ignore().add(patterns);
  const ancestors: string[] = [];
  let cursor = selected;
  while (true) {
    ancestors.unshift(cursor);
    try { await lstat(join(cursor, '.git')); break; } catch { /* Continue toward repository root. */ }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const matchers = (await Promise.all(ancestors.map(matcher))).filter((item): item is Matcher => item !== null);
  const selection: Selection = { folder: selected, files: [], excluded: 0, bytes: 0 };
  const ignored = (path: string, directory: boolean, rules: Matcher[]): boolean => {
    const name = slash(relative(selected, path)) + (directory ? '/' : '');
    if (inside(selected, path) && name !== '/' && name && (mandatory.ignores(name) || excluded.ignores(name))) return true;
    let blocked = false;
    for (const item of rules) {
      const local = slash(relative(item.directory, path)) + (directory ? '/' : '');
      if (!local || local === '/') continue;
      const result = item.rules.test(local);
      if (result.ignored) blocked = true;
      if (result.unignored) blocked = false;
    }
    return blocked;
  };
  // Ancestor ignores can exclude the selected subdirectory itself.
  for (const ancestor of ancestors.slice(1)) {
    if (ignored(ancestor, true, matchers.filter(item => item.directory !== ancestor && inside(item.directory, ancestor)))) {
      throw new Error('This folder is excluded by an applicable .gitignore rule.');
    }
  }
  const walk = async (directory: string, inherited: Matcher[]): Promise<void> => {
    signal?.throwIfAborted();
    const nested = directory === selected ? null : await matcher(directory);
    const rules = nested ? [...inherited, nested] : inherited;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || ignored(absolute, entry.isDirectory(), rules)) { selection.excluded++; continue; }
      if (entry.isDirectory()) { await walk(absolute, rules); continue; }
      const info = await stat(absolute);
      selection.bytes += info.size;
      if (selection.bytes > maximumBytes) throw new Error('This folder exceeds the DocuWriter upload limit. Select a smaller folder or exclude unnecessary files.');
      selection.files.push({ absolute, name: slash(relative(selected, absolute)), size: info.size });
    }
  };
  await walk(selected, matchers);
  if (!selection.files.length) throw new Error('No uploadable files remain after exclusions.');
  return selection;
}

export async function packageSnapshot(selection: Selection, stateDirectory: string, signal?: AbortSignal): Promise<{ archive: string; size: number }> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(stateDirectory, 'snapshot-'));
  const archivePath = join(temporary, 'source.zip');
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 });
  const completion = new Promise<void>((resolveDone, reject) => {
    output.on('close', resolveDone); output.on('error', reject); archive.on('error', reject);
    archive.on('warning', reject);
  });
  // Attach a handler immediately, including while file handles are being prepared.
  void completion.catch(() => {});
  archive.pipe(output);
  const handles = [];
  const onAbort = () => { archive.abort(); output.destroy(new Error('Operation cancelled.')); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (const file of selection.files) {
      signal?.throwIfAborted();
      const actual = await realpath(file.absolute);
      if (!inside(selection.folder, actual) || actual !== file.absolute) throw new Error('Project files changed while packaging. Run the command again.');
      const handle = await open(file.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      handles.push(handle);
      const info = await handle.stat();
      if (!info.isFile() || info.size !== file.size) throw new Error('Project files changed while packaging. Run the command again.');
      const entered = once(archive, 'entry');
      archive.append(handle.createReadStream({ autoClose: false }), { name: `project/${file.name}`, mode: 0o644 });
      await Promise.race([entered, completion]);
      await handle.close();
    }
    await archive.finalize();
    await completion;
    return { archive: archivePath, size: (await stat(archivePath)).size };
  } catch (error) {
    archive.abort(); output.destroy();
    await Promise.all(handles.map(handle => handle.close().catch(() => {})));
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally { signal?.removeEventListener('abort', onAbort); }
}

export async function removeSnapshot(path: string, stateDirectory: string): Promise<void> {
  const directory = dirname(path);
  if (!inside(stateDirectory, directory) || !basename(directory).startsWith('snapshot-')) throw new Error('Unsafe temporary snapshot path.');
  await rm(directory, { recursive: true, force: true });
}
