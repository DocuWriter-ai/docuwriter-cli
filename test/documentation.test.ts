import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { documentationLocations, documentationPath, selectDocumentation } from '../src/documentation.js';
import { selectFiles } from '../src/snapshot.js';
let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
it('selects Markdown and referenced allowed assets, preserving their project-relative paths', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'documentation-test-')));
  await mkdir(join(root, 'docs')); await mkdir(join(root, 'images')); await mkdir(join(root, 'secret'));
  const files = {
    'README.md': '# Readme', 'main.ts': 'source', '.gitignore': 'secret/\n',
    'docs/guide.md': '# Guide\n![Diagram](../images/a%20b.png)\n![Ref][diagram]\n[diagram]: ../images/ref.webp\n![Private](../secret/image.png)\n![External](https://example.com/image.png)\n![Bad](../linked.png)',
    'docs/nested.markdown': '# More', 'images/a b.png': 'png', 'images/ref.webp': 'webp', 'images/unused.jpg': 'unused', 'secret/image.png': 'secret',
  };
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  await symlink(join(root, 'images', 'unused.jpg'), join(root, 'linked.png'));
  const available = await selectFiles(root, [], Number.MAX_SAFE_INTEGER);
  expect(documentationLocations(available)).toEqual(['.', 'docs/', 'docs/guide.md', 'docs/nested.markdown', 'README.md']);
  const selected = await selectDocumentation(available, 'docs/', 10_000);
  expect(selected.files.map(file => file.name)).toEqual(['docs/guide.md', 'docs/nested.markdown', 'images/a b.png', 'images/ref.webp']);
  expect(documentationPath(available, '../outside')).toBeUndefined();
  expect(documentationPath(available, '/etc')).toBeUndefined();
  expect(documentationPath(available, 'secret')).toBeUndefined();
  expect(documentationPath(available, 'docs/../README.md')).toBe('README.md');
  await expect(selectDocumentation(available, 'docs', 1)).rejects.toThrow('upload limit');
});
it('supports selecting one Markdown file without adding sibling documentation', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'documentation-test-')));
  await writeFile(join(root, 'a.md'), '# A'); await writeFile(join(root, 'b.md'), '# B');
  const available = await selectFiles(root, [], 10_000);
  expect((await selectDocumentation(available, 'a.md', 10_000)).files.map(file => file.name)).toEqual(['a.md']);
});

it('combines multiple locations and deduplicates overlapping documents and images', async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'documentation-test-')));
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'guide.md'), '# Guide\n![Image](../image.png)');
  await writeFile(join(root, 'README.md'), '# Home\n![Image](image.png)');
  await writeFile(join(root, 'unused.md'), '# Not selected');
  await writeFile(join(root, 'image.png'), 'image');
  const available = await selectFiles(root, [], 10_000);

  const selected = await selectDocumentation(available, ['docs/', 'docs/guide.md', 'README.md'], 10_000);

  expect(selected.files.map(file => file.name)).toEqual(['docs/guide.md', 'image.png', 'README.md']);
  expect(selected.bytes).toBe(selected.files.reduce((total, file) => total + file.size, 0));
  await expect(selectDocumentation(available, [], 10_000)).rejects.toThrow('at least one');
  await expect(selectDocumentation(available, ['docs', '../outside'], 10_000)).rejects.toThrow('inside this project');
  await expect(selectDocumentation(available, ['docs', 'README.md'], selected.bytes - 1)).rejects.toThrow('upload limit');
});
