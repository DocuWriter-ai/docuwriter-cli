import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';
import type { Selection } from './snapshot.js';

const markdown = (name: string): boolean => /\.(md|markdown)$/i.test(name);
const image = (name: string): boolean => /\.(png|jpe?g|gif|webp)$/i.test(name);
export function documentationLocations(selection: Selection): string[] {
  const files = selection.files.filter(file => markdown(file.name)).map(file => file.name);
  const directories = new Set(files.map(file => posix.dirname(file)));
  return [...[...directories].sort().map(directory => directory === '.' ? '.' : `${directory}/`), ...files];
}

export function documentationOptions(selection: Selection): { value: string; label: string; hint: string }[] {
  const documents = [...new Set(selection.files.filter(file => markdown(file.name)).map(file => file.name))];
  const locations = [...new Set(documentationLocations(selection))].sort((first, second) => {
    const firstDirectory = first === '.' || first.endsWith('/');
    const secondDirectory = second === '.' || second.endsWith('/');
    return Number(secondDirectory) - Number(firstDirectory) || first.replace(/\/$/, '').localeCompare(second.replace(/\/$/, ''));
  });
  return locations.map(value => {
    const pageCount = documents.filter(name => value === '.' || name === value || (value.endsWith('/') && name.startsWith(value))).length;
    return { value, label: value === '.' ? 'All documentation' : value, hint: `${pageCount} ${pageCount === 1 ? 'page' : 'pages'}` };
  });
}

export function documentationSummary(selection: Selection): string {
  const files = [...new Map(selection.files.map(file => [file.name, file])).values()];
  const pages = files.filter(file => markdown(file.name)).length;
  const images = files.filter(file => image(file.name)).length;
  return `${pages} ${pages === 1 ? 'page' : 'pages'} · ${images} ${images === 1 ? 'image' : 'images'} · ${files.length} ${files.length === 1 ? 'file' : 'files'}`;
}

export function documentationPath(selection: Selection, input: string): string | undefined {
  const value = input.trim();
  if (!value || isAbsolute(value) || value.includes('\\')) return undefined;
  const absolute = resolve(selection.folder, value);
  const local = relative(selection.folder, absolute);
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) return undefined;
  const name = local.split(sep).join('/') || '.';
  return selection.files.some(file => markdown(file.name) && (name === '.' || file.name === name || file.name.startsWith(`${name}/`))) ? name : undefined;
}

export async function selectDocumentation(selection: Selection, input: string | string[], maximumBytes: number, signal?: AbortSignal): Promise<Selection> {
  const inputs = Array.isArray(input) ? input : [input];
  const locations = inputs.map(value => documentationPath(selection, value));
  if (!locations.length || locations.some(location => !location)) throw new Error('Select at least one Markdown file or folder inside this project that is not excluded.');
  const documents = selection.files.filter(file => markdown(file.name) && locations.some(location => location === '.' || file.name === location || file.name.startsWith(`${location}/`)));
  const selected = new Map(documents.map(file => [file.name, file]));
  const available = new Map(selection.files.filter(file => image(file.name)).map(file => [file.name, file]));
  for (const file of documents) {
    signal?.throwIfAborted();
    const text = await readFile(file.absolute, 'utf8');
    const references = new Map<string, string>();
    for (const match of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))/gm)) references.set(match[1].trim().toLowerCase(), match[2] ?? match[3]);
    const targets: string[] = [];
    for (const match of text.matchAll(/!\[([^\]]*)\](?:\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\)|\[([^\]]*)\])?/g)) {
      const target = match[2] ?? match[3] ?? references.get((match[4] || match[1]).trim().toLowerCase());
      if (target) targets.push(target);
    }
    for (const target of targets) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(target)) continue;
      let decoded: string;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); } catch { continue; }
      if (decoded.includes('\\') || decoded.includes('\0')) continue;
      const name = posix.normalize(posix.join(posix.dirname(file.name), decoded));
      const asset = available.get(name);
      if (asset) selected.set(name, asset);
    }
  }
  const files = [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  if (bytes > maximumBytes) throw new Error('The selected documentation exceeds the DocuWriter upload limit. Select a smaller documentation folder.');
  return { ...selection, files, bytes };
}
