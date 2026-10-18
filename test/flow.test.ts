import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage as ActualStorage } from '../src/storage.js';
import type { Context } from '../src/types.js';

const mocks = vi.hoisted(() => ({ state: '', select: vi.fn(), multiselect: vi.fn(), text: vi.fn(), confirm: vi.fn(), session: vi.fn(), notes: vi.fn(), browser: vi.fn() }));
vi.mock('../src/storage.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/storage.js')>();
  return { ...actual, Storage: class extends actual.Storage { constructor(origin: string) { super(origin, mocks.state); } } };
});
vi.mock('../src/auth.js', () => ({ Authentication: class { session = mocks.session; } }));
vi.mock('open', () => ({ default: mocks.browser }));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  select: mocks.select, multiselect: mocks.multiselect, text: mocks.text, confirm: mocks.confirm, note: mocks.notes,
  log: { info: vi.fn() }, spinner: () => ({ start: vi.fn(), message: vi.fn(), stop: vi.fn() }),
}));
import { run } from '../src/flow.js';

const context: Context = {
  account: { id: 'account-uuid', name: 'Developer', email: 'demo@example.test' }, eligible: true, documentation_import: { enabled: true },
  documentation_types: [{ value: 'internal', title: 'Internal technical docs', desc: 'Architecture and implementation' }],
  profile: { company: 'Example', sector: 'Custom saved sector', timezone: 'Europe/Madrid' }, sectors: ['Technology'],
  goal: { prompt: 'What are you hoping this documentation will help you or your team accomplish?', max_length: 500, skippable: true },
  upload: { max_bytes: 100_000, part_size: 100_000 }, exclusions: { version: 1, patterns: [] },
};
let root: string;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const stderrTty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
beforeEach(async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '1');
  root = await realpath(await mkdtemp(join(tmpdir(), 'docuwriter-flow-test-')));
  mocks.state = join(root, 'state');
  await mkdir(join(root, 'project'));
  await writeFile(join(root, 'project', 'main.ts'), 'export const demo = true;');
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
  Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  mocks.session.mockResolvedValue({ access_token: 'session', expires_at: Date.now() + 100_000, client_id: 'cli' });
  process.exitCode = 0;
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  if (stdinTty) Object.defineProperty(process.stdin, 'isTTY', stdinTty); else delete (process.stdin as { isTTY?: boolean }).isTTY;
  if (stderrTty) Object.defineProperty(process.stderr, 'isTTY', stderrTty); else delete (process.stderr as { isTTY?: boolean }).isTTY;
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

function acceptedFetch(spaceId = 123) {
  return vi.fn().mockResolvedValueOnce(Response.json(context))
    .mockResolvedValueOnce(Response.json({ token: 'upload', part_size: 100_000, parts: [{ part_number: 1, url: 'https://storage.example/signed?secret=hidden' }] }))
    .mockResolvedValueOnce(new Response(null, { headers: { etag: 'part' } }))
    .mockResolvedValueOnce(Response.json({ completed: true }))
    .mockResolvedValueOnce(Response.json({ status: 'accepted', submission_id: 'submission', repository_uuid: 'repo', space_id: spaceId, continuation_url: 'https://app.docuwriter.ai/spaces/123' }));
}
it('runs the complete deterministic guided handoff with saved custom sector and timezone skip, then cleans state', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.text.mockResolvedValueOnce('Example').mockResolvedValue('');
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Custom saved sector')
    .mockResolvedValueOnce('skip');
  const fetch = acceptedFetch(); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(process.exitCode).toBe(0);
  const submission = JSON.parse(fetch.mock.calls[4][1].body);
  expect(submission).toMatchObject({ documentation_type: 'internal', sector: 'Custom saved sector', timezone: null, documentation_goal: null });
  expect(mocks.select.mock.calls[2][0].options).toContainEqual({ value: 'Custom saved sector', label: 'Custom saved sector' });
  expect(mocks.browser).not.toHaveBeenCalled();
  const storage = new ActualStorage('https://app.docuwriter.ai', mocks.state);
  expect(await readdir(storage.directory)).toEqual([]);
  const result = JSON.parse(vi.mocked(process.stdout.write).mock.calls[0][0] as string);
  expect(result).toMatchObject({ status: 'accepted', space_id: 123, continuation_url: 'https://app.docuwriter.ai/spaces/123' });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(fetch.mock.calls).toHaveLength(5); // No documentation progress polling.
});
it('uploads the questionnaire answers and custom sector without a review or second confirmation', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.text.mockResolvedValueOnce('Updated').mockResolvedValueOnce('Manufacturing').mockResolvedValueOnce('');
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('__custom__').mockResolvedValueOnce('current');
  const fetch = acceptedFetch(); vi.stubGlobal('fetch', fetch);

  await run('start', { cwd: join(root, 'project'), open: false });

  expect(JSON.parse(fetch.mock.calls[4][1].body)).toMatchObject({ company: 'Updated', sector: 'Manufacturing', timezone: 'Europe/Madrid' });
  expect(mocks.text.mock.calls[0][0]).toMatchObject({ message: 'Company or project name (optional)', initialValue: 'project' });
  expect(mocks.confirm).toHaveBeenCalledTimes(1);
  expect(mocks.select.mock.calls.map(([options]) => options.message)).toEqual([
    'Do you already have documentation?', 'What type of documentation do you need?', 'Sector (optional)', 'Timezone (optional)',
  ]);
  expect(mocks.notes.mock.calls.map(([, title]) => title)).toEqual(['Your project']);
  expect(process.exitCode).toBe(0);
  const humanOutput = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
  expect(humanOutput).toContain('Space ID: 123');
  expect(humanOutput).toContain('Follow documentation progress in DocuWriter: https://app.docuwriter.ai/spaces/123');
});
it('cancels during the questionnaire without packaging or uploading', async () => {
  mocks.confirm.mockResolvedValue(true); mocks.text.mockResolvedValueOnce('Example').mockResolvedValueOnce(Symbol('cancel'));
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Technology');
  const fetch = vi.fn().mockResolvedValue(Response.json(context)); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(await readdir(new ActualStorage('https://app.docuwriter.ai', mocks.state).directory)).toEqual([]);
  expect(process.exitCode).toBe(130);
});
it('invalidates a revoked saved session and reauthorizes once before continuing', async () => {
  mocks.confirm.mockResolvedValue(true); mocks.text.mockResolvedValueOnce('Example').mockResolvedValueOnce(Symbol('cancel'));
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Technology');
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 })).mockResolvedValueOnce(Response.json(context));
  vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false });
  expect(mocks.session.mock.calls.map(call => call[1])).toEqual([false, true]);
  expect(fetch).toHaveBeenCalledTimes(2);
});


it('asks for the goal directly as open text and preserves the submitted prose', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.text.mockResolvedValueOnce('Example').mockResolvedValueOnce('  Help new engineers understand the architecture.  ');
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Technology').mockResolvedValueOnce('current');
  const fetch = acceptedFetch(); vi.stubGlobal('fetch', fetch);

  await run('start', { cwd: join(root, 'project'), open: false });

  expect(JSON.parse(fetch.mock.calls[4][1].body).documentation_goal).toBe('Help new engineers understand the architecture.');
  expect(mocks.select.mock.calls.some(([options]) => options.message === context.goal.prompt)).toBe(false);
  const goalPrompts = mocks.text.mock.calls.filter(([options]) => options.message === context.goal.prompt);
  expect(goalPrompts).toHaveLength(1);
  const options = goalPrompts[0][0];
  expect(options.placeholder).toContain('press Enter for Not now');
  expect(options.validate('')).toBeUndefined();
  expect(options.validate('x'.repeat(500))).toBeUndefined();
  expect(options.validate('x'.repeat(501))).toBe('Use 500 characters or fewer.');
  expect(process.exitCode).toBe(0);
});

it('opens the direct Space URL and exits without waiting for documentation generation', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.text.mockResolvedValueOnce('Example').mockResolvedValueOnce('');
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Technology').mockResolvedValueOnce('current');
  const fetch = acceptedFetch(); vi.stubGlobal('fetch', fetch);

  await run('start', { cwd: join(root, 'project'), open: true });

  expect(mocks.browser).toHaveBeenCalledExactlyOnceWith('https://app.docuwriter.ai/spaces/123');
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(process.exitCode).toBe(0);
});

it('keeps the submission identity when an accepted receipt has an invalid Space ID', async () => {
  mocks.confirm.mockResolvedValue(true);
  mocks.text.mockResolvedValueOnce('Example').mockResolvedValueOnce('');
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('Technology').mockResolvedValueOnce('current');
  vi.stubGlobal('fetch', acceptedFetch(0));

  await run('start', { cwd: join(root, 'project'), open: true, json: true });

  expect(process.exitCode).toBe(1);
  const result = JSON.parse(vi.mocked(process.stdout.write).mock.calls[0][0] as string);
  expect(result.status).toBe('error');
  expect(mocks.browser).not.toHaveBeenCalled();
  const storage = new ActualStorage('https://app.docuwriter.ai', mocks.state);
  const pending = await storage.read<{ completed: boolean; idempotency_key: string }>('pending');
  expect(pending?.completed).toBe(true);
  expect(pending?.idempotency_key).toBeTruthy();
});

it('offers an explicit import path and sends only selected documentation and referenced images', async () => {
  await mkdir(join(root, 'project', 'docs'));
  await writeFile(join(root, 'project', 'docs', 'guide.md'), '# Guide\n![Logo](logo.png)');
  await writeFile(join(root, 'project', 'docs', 'logo.png'), 'image');
  await writeFile(join(root, 'project', 'docs', 'unreferenced.png'), 'unused');
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('import');
  mocks.multiselect.mockResolvedValueOnce(['docs/', 'docs/guide.md']);
  mocks.text.mockResolvedValueOnce('Existing docs');
  const fetch = acceptedFetch(); vi.stubGlobal('fetch', fetch);

  await run('start', { cwd: join(root, 'project'), open: false });

  expect(process.exitCode).toBe(0);
  expect(fetch.mock.calls[4][0]).toBe('https://app.docuwriter.ai/api/cli/v1/documentation-imports');
  expect(JSON.parse(fetch.mock.calls[4][1].body)).toEqual({ idempotency_key: expect.any(String), multipart_upload_token: 'upload', source_name: 'project', space_name: 'Existing docs' });
  expect(mocks.multiselect.mock.calls[0][0]).toMatchObject({ message: 'Which documentation would you like to import?', required: true });
  expect(mocks.text.mock.calls.map(([options]) => options.message)).toEqual(['Space name']);
  expect(mocks.text.mock.calls[0][0].initialValue).toBe('project');
  const archive = fetch.mock.calls[2][1].body as Buffer;
  expect(archive.includes(Buffer.from('project/docs/guide.md'))).toBe(true);
  expect(archive.includes(Buffer.from('project/docs/logo.png'))).toBe(true);
  expect(archive.includes(Buffer.from('unreferenced.png'))).toBe(false);
  expect(archive.includes(Buffer.from('main.ts'))).toBe(false);
  expect(vi.mocked(process.stdout.write).mock.calls[0][0]).toContain('Documentation import started.');
});
it('validates a custom documentation path and does not upload when import selection is cancelled', async () => {
  await writeFile(join(root, 'project', 'README.md'), '# Existing');
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('import');
  mocks.multiselect.mockResolvedValueOnce(['__custom__']);
  mocks.text.mockResolvedValueOnce(Symbol('cancel'));
  const fetch = vi.fn().mockResolvedValue(Response.json(context)); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  const validation = mocks.text.mock.calls[0][0].validate;
  expect(validation('../outside.md')).toContain('inside this project');
  expect(validation('README.md')).toBeUndefined();
  expect(process.exitCode).toBe(130);
});
it('does not run generation as a fallback when existing documentation is absent', async () => {
  mocks.confirm.mockResolvedValue(true); mocks.select.mockResolvedValueOnce('import');
  const fetch = vi.fn().mockResolvedValue(Response.json(context)); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(mocks.text).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
  expect(vi.mocked(process.stdout.write).mock.calls[0][0]).toContain('No Markdown documentation');
});

it.each(['generate', 'import'])('records the full %s journey without leaking source paths, images, tokens, or signed URLs', async mode => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0');
  mocks.confirm.mockResolvedValue(true);
  if (mode === 'import') {
    await mkdir(join(root, 'project', 'docs'));
    await writeFile(join(root, 'project', 'docs', 'private.md'), '# Hello');
    mocks.select.mockResolvedValueOnce('import'); mocks.multiselect.mockResolvedValueOnce(['docs/']); mocks.text.mockResolvedValueOnce('Private Space name');
  } else {
    mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
    mocks.text.mockResolvedValueOnce('Example Company').mockResolvedValueOnce('Help new engineers');
  }
  const business = acceptedFetch();
  const telemetry: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetch = vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    if (String(url).endsWith('/events')) {
      const body = JSON.parse(String(options.body)); telemetry.push({ url: String(url), body, headers: options.headers as Record<string, string> });
      return Response.json({ accepted: body.events.length });
    }
    return business(url, options);
  });
  vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(process.exitCode).toBe(0);
  const events = telemetry.flatMap(batch => batch.body.events);
  for (const event of ['cli_command_started', 'cli_auth_completed', 'cli_prompt_shown', 'cli_workflow_selected', 'cli_packaging_started', 'cli_packaging_completed', 'cli_upload_started', 'cli_upload_part_completed', 'cli_upload_completed', 'cli_submission_received', 'cli_browser_skipped', 'cli_command_completed', 'cli_command_exited']) expect(events.some(item => item.event === event), event).toBe(true);
  expect(events.filter(item => item.event === 'cli_workflow_selected')[0].properties.workflow).toBe(mode);
  const transmitted = JSON.stringify(telemetry);
  expect(transmitted).not.toContain(root); expect(transmitted).not.toContain('private.md'); expect(transmitted).not.toContain('Private Space name'); expect(transmitted).not.toContain('secret=hidden');
  if (mode === 'generate') {
    expect(events.find(item => item.event === 'cli_prompt_answered' && item.properties.prompt === 'company').properties.value).toBe('Example Company');
    expect(events.find(item => item.event === 'cli_prompt_skipped' && item.properties.prompt === 'sector')).toBeDefined();
  } else expect(events.find(item => item.event === 'cli_documentation_selected').properties.page_count).toBe(1);
  expect((business.mock.calls[0][1].headers as Record<string, string>)['X-DocuWriter-Telemetry']).toBe('0');
  expect(telemetry.every(batch => batch.url === 'https://app.docuwriter.ai/api/cli/v1/events' && batch.headers.Authorization === 'Bearer session')).toBe(true);
  expect(events.some(item => item.event === 'cli_folder_confirmed' || item.properties.prompt === 'folder')).toBe(false);
  const signed = business.mock.calls.find(call => String(call[0]).includes('storage.example'))!;
  expect(signed[1].headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Length': String((signed[1].body as Buffer).length) });
});
it('propagates opt-out to browser authorization and every platform request', async () => {
  mocks.session.mockImplementationOnce(async (authorize: (code: string, url: string) => Promise<void>) => {
    await authorize('ABCD1234', 'https://app.docuwriter.ai/oauth/device?user_code=ABCD1234');
    return { access_token: 'session', client_id: 'cli', expires_at: Date.now() + 100_000 };
  });
  const fetch = vi.fn().mockResolvedValue(Response.json(context)); vi.stubGlobal('fetch', fetch);
  await run('login', { open: true });
  expect(process.exitCode).toBe(0);
  expect(mocks.browser).toHaveBeenCalledWith('https://app.docuwriter.ai/oauth/device?user_code=ABCD1234&cli_telemetry=0');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].headers['X-DocuWriter-Telemetry']).toBe('0');
  expect(fetch.mock.calls[0][1].headers['X-DocuWriter-Installation-Id']).toBeUndefined();
});

it('sends no analytics for a cancelled pre-authentication folder confirmation', async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0'); mocks.confirm.mockResolvedValue(false);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false });
  expect(fetch).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  expect((await new ActualStorage('https://app.docuwriter.ai', mocks.state).read<{ events: unknown[] }>('telemetry'))?.events).toEqual([]);
});

it('does not track an authorization failure before account verification', async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0'); mocks.session.mockRejectedValueOnce(new Error('Authorization was declined.'));
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await run('login', { open: false });
  expect(process.exitCode).toBe(1); expect(fetch).not.toHaveBeenCalled();
  expect((await new ActualStorage('https://app.docuwriter.ai', mocks.state).read<{ events: unknown[] }>('telemetry'))?.events).toEqual([]);
});
it('does not send anonymous analytics from noninteractive commands', async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0'); Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(process.exitCode).toBe(2); expect(fetch).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  expect((await new ActualStorage('https://app.docuwriter.ai', mocks.state).read<{ events: unknown[] }>('telemetry'))?.events).toEqual([]);
});


it.each(['generate', 'import'])('reports the free ZIP cap and cleans the packaged %s snapshot before transfer', async mode => {
  await writeFile(join(root, 'project', 'README.md'), '# Existing documentation');
  mocks.confirm.mockResolvedValue(true);
  if (mode === 'import') {
    mocks.select.mockResolvedValueOnce('import'); mocks.multiselect.mockResolvedValueOnce(['README.md']); mocks.text.mockResolvedValueOnce('Docs');
  } else {
    mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
    mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  }
  const fetch = vi.fn().mockResolvedValue(Response.json({ ...context, upload: { ...context.upload, max_bytes: 1, plan_max_bytes: 1, max_uncompressed_bytes: 100_000, pricing_url: '/pricing' } }));
  vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: true, json: true });
  expect(fetch).toHaveBeenCalledTimes(1); expect(process.exitCode).toBe(1); expect(mocks.browser).not.toHaveBeenCalled();
  expect(JSON.parse(vi.mocked(process.stdout.write).mock.calls[0][0] as string)).toEqual({ status: 'error', error: 'zip_upload_plan_limit',
    message: 'Your free plan supports ZIP uploads up to 1 GB. Upgrade to upload larger projects.', max_bytes: 1, max_label: '1 GB', upgrade_required: true, pricing_url: 'https://app.docuwriter.ai/pricing' });
  expect(await readdir(new ActualStorage('https://app.docuwriter.ai', mocks.state).directory)).toEqual([]);
});

it.each(['generate', 'import'])('applies the %s plan limit to the compressed ZIP rather than raw selection', async mode => {
  await writeFile(join(root, 'project', 'README.md'), '# Repeated documentation\n'.repeat(300));
  mocks.confirm.mockResolvedValue(true);
  if (mode === 'import') {
    mocks.select.mockResolvedValueOnce('import'); mocks.multiselect.mockResolvedValueOnce(['README.md']); mocks.text.mockResolvedValueOnce('Docs');
  } else {
    mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
    mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  }
  const fetch = acceptedFetch();
  // Replace only the initial context while keeping the accepted upload responses.
  const routed = vi.fn(async (...args: Parameters<typeof fetch>) => {
    if (String(args[0]).endsWith('/context')) {
      await fetch(...args);
      return Response.json({ ...context, upload: { ...context.upload, max_bytes: 1000, plan_max_bytes: 1000, max_uncompressed_bytes: 100_000, pricing_url: '/pricing' } });
    }
    return fetch(...args);
  });
  vi.stubGlobal('fetch', routed);
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(process.exitCode).toBe(0);
  const uploaded = routed.mock.calls.find(call => String(call[0]).includes('storage.example'))!;
  expect((uploaded[1].body as Buffer).length).toBeLessThanOrEqual(1000);
});


it.each(['generate', 'import'])('accepts a %s ZIP exactly equal to its inclusive plan cap', async mode => {
  const { selectFiles, packageSnapshot, removeSnapshot } = await import('../src/snapshot.js');
  const { selectDocumentation } = await import('../src/documentation.js');
  await writeFile(join(root, 'project', 'README.md'), '# Documentation');
  const files = await selectFiles(join(root, 'project'), [], 100_000);
  const selected = mode === 'import' ? await selectDocumentation(files, ['README.md'], 100_000) : files;
  const measured = await packageSnapshot(selected, join(root, 'measured'));
  const limit = measured.size;
  await removeSnapshot(measured.archive, join(root, 'measured'));
  mocks.confirm.mockResolvedValue(true);
  if (mode === 'import') {
    mocks.select.mockResolvedValueOnce('import'); mocks.multiselect.mockResolvedValueOnce(['README.md']); mocks.text.mockResolvedValueOnce('Docs');
  } else {
    mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
    mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  }
  const business = acceptedFetch();
  const fetch = vi.fn(async (...args: Parameters<typeof business>) => {
    if (String(args[0]).endsWith('/context')) {
      await business(...args);
      return Response.json({ ...context, upload: { ...context.upload, max_bytes: limit, plan_max_bytes: limit, max_uncompressed_bytes: 100_000, pricing_url: '/pricing' } });
    }
    return business(...args);
  });
  vi.stubGlobal('fetch', fetch);
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(process.exitCode).toBe(0);
  expect((fetch.mock.calls.find(call => String(call[0]).includes('storage.example'))![1].body as Buffer).length).toBe(limit);
});

it.each([
  ['packaging', 'packaging_failed', undefined],
  ['plan_limit', 'zip_upload_plan_limit', undefined],
  ['upload_planning', 'access_denied', 403],
  ['upload_part', 'access_denied', 403],
  ['upload_completion', 'validation_failed', 422],
  ['submission', 'validation_failed', 422],
] as const)('sends authenticated sanitized diagnostics for %s failures', async (failureStage, code, status) => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0');
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
  mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  const business = acceptedFetch();
  const events: any[] = [];
  const requestId = '12345678-1234-4567-8901-123456789012';
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    if (String(url).endsWith('/events')) {
      expect((options.headers as Record<string, string>).Authorization).toBe('Bearer session');
      const batch = JSON.parse(String(options.body)); events.push(...batch.events);
      return Response.json({ accepted: batch.events.length });
    }
    const businessStage = String(url).endsWith('/uploads') ? 'upload_planning' : String(url).includes('storage.example') ? 'upload_part'
      : String(url).endsWith('/complete') ? 'upload_completion' : String(url).endsWith('/submissions') ? 'submission' : 'context';
    if (businessStage === failureStage) return Response.json({ error: 'sensitive-server-value' }, { status, headers: { 'X-DocuWriter-Request-Id': requestId } });
    const response = await business(url, options);
    if (businessStage === 'context' && ['packaging', 'plan_limit'].includes(failureStage)) return Response.json({ ...context, upload: { ...context.upload,
      ...(failureStage === 'packaging' ? { max_uncompressed_bytes: 1 } : { max_bytes: 1, plan_max_bytes: 1, pricing_url: '/pricing' }) } });
    return response;
  }));
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  const failure = events.find(event => event.event === 'cli_failed');
  expect(failure?.properties).toMatchObject({ stage: failureStage === 'plan_limit' ? 'packaging' : failureStage, error_code: code, attempt: 0 });
  if (status) expect(failure.properties).toMatchObject({ status, ...(failureStage === 'upload_part' ? {} : { request_id: requestId }) });
  expect(JSON.stringify(events)).not.toContain(root);
  expect(JSON.stringify(events)).not.toContain('sensitive-server-value');
  expect(JSON.stringify(events)).not.toContain('secret=hidden');
  expect(process.exitCode).toBe(1);
});

it('records a sanitized browser launch failure without failing an accepted submission', async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0');
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
  mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  mocks.browser.mockRejectedValueOnce(new Error('/private/executable secret-value'));
  const business = acceptedFetch(); const events: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    if (String(url).endsWith('/events')) {
      const batch = JSON.parse(String(options.body)); events.push(...batch.events); return Response.json({ accepted: batch.events.length });
    }
    return business(url, options);
  }));
  await run('start', { cwd: join(root, 'project'), open: true, json: true });
  expect(events.find(event => event.event === 'cli_browser_failed')?.properties).toEqual({ workflow: 'generate', destination: 'space', stage: 'browser', error_code: 'browser_open_failed' });
  expect(events.some(event => event.event === 'cli_command_completed')).toBe(true);
  expect(JSON.stringify(events)).not.toContain('secret-value'); expect(process.exitCode).toBe(0);
});


it('records each bounded upload retry and the exhausted retry count', async () => {
  vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0');
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
  mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  const business = acceptedFetch(); const events: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    if (String(url).endsWith('/events')) {
      const batch = JSON.parse(String(options.body)); events.push(...batch.events); return Response.json({ accepted: batch.events.length });
    }
    if (String(url).includes('storage.example')) return new Response('private-storage-body', { status: 503 });
    return business(url, options);
  }));
  await run('start', { cwd: join(root, 'project'), open: false, json: true });
  expect(events.filter(event => event.event === 'cli_upload_retry').map(event => event.properties)).toEqual([1, 2, 3].map(attempt => ({ workflow: 'generate', stage: 'upload_part', error_code: 'service_unavailable', status: 503, attempt })));
  expect(events.find(event => event.event === 'cli_failed')?.properties).toEqual({ workflow: 'generate', stage: 'upload_part', error_code: 'service_unavailable', status: 503, attempt: 3 });
  expect(JSON.stringify(events)).not.toContain('private-storage-body'); expect(process.exitCode).toBe(1);
});


it.each([
  [true, '12345678-1234-4567-8901-123456789012'],
  [false, '12345678-1234-4567-8901-123456789012'],
  [true, 'https://attacker.example/private-token'],
  [false, 'https://attacker.example/private-token'],
])('exposes only validated support references in final errors (json=%s)', async (json, reference) => {
  mocks.confirm.mockResolvedValue(true);
  mocks.select.mockResolvedValueOnce('generate').mockResolvedValueOnce('internal').mockResolvedValueOnce('').mockResolvedValueOnce('current');
  mocks.text.mockResolvedValueOnce('Project').mockResolvedValueOnce('');
  const business = acceptedFetch();
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, options: RequestInit = {}) => {
    if (String(url).endsWith('/uploads')) return Response.json({ error: 'private-server-message' }, { status: 422, headers: { 'X-DocuWriter-Request-Id': reference } });
    return business(url, options);
  }));
  await run('start', { cwd: join(root, 'project'), open: false, json });
  const output = vi.mocked(process.stdout.write).mock.calls[0][0] as string;
  if (reference.startsWith('12345678')) {
    if (json) expect(JSON.parse(output).request_id).toBe(reference);
    else expect(output).toContain(`Support reference: ${reference}`);
  } else {
    expect(output).not.toContain('attacker.example'); expect(output).not.toContain('private-token');
    if (json) expect(JSON.parse(output).request_id).toBeUndefined();
    else expect(output).not.toContain('Support reference:');
  }
  expect(output).not.toContain('private-server-message'); expect(process.exitCode).toBe(1);
});
