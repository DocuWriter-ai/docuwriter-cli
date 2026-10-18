import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Storage } from '../src/storage.js';
import { Telemetry } from '../src/telemetry.js';
let directory: string;
let storage: Storage;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'cli-telemetry-')); storage = new Storage('https://app.docuwriter.ai', directory); vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '0'); });
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); });
it('drops all pre-authentication events and batches only authenticated account answers', async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) => Response.json({ accepted: JSON.parse(options.body).events.length })); vi.stubGlobal('fetch', fetch);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage);
  expect(await telemetry.initialize()).toBe(true); await telemetry.disclose();
  telemetry.track('cli_command_started', { command: 'start' });
  telemetry.promptAnswer('company', 'secret-before-auth');
  await telemetry.authenticate('private-token', '123');
  telemetry.setWorkflow('generate');
  for (let index = 0; index < 55; index++) telemetry.promptAnswer('documentation_goal', 'Help onboarding');
  await telemetry.finish();
  expect(fetch.mock.calls).toHaveLength(3);
  expect(fetch.mock.calls.every(call => call[0] === 'https://app.docuwriter.ai/api/cli/v1/events')).toBe(true);
  expect(fetch.mock.calls.every(call => call[1].headers.Authorization === 'Bearer private-token')).toBe(true);
  const batches = fetch.mock.calls.map(call => JSON.parse(call[1].body));
  const events = batches.flatMap(batch => batch.events);
  expect(events).toHaveLength(55);
  expect(events.map(event => event.sequence)).toEqual(Array.from({ length: 55 }, (_, index) => index + 1));
  expect(new Set(events.map(event => event.event_id)).size).toBe(55);
  expect(JSON.stringify(batches)).not.toContain('secret-before-auth');
  expect(JSON.stringify(batches)).not.toContain('private-token');
  expect(events[0].properties).toEqual({ workflow: 'generate', prompt: 'documentation_goal', value: 'Help onboarding' });
  expect(batches.every(batch => batch.events.length <= 25)).toBe(true);
  const next = new Telemetry('https://app.docuwriter.ai', storage); expect(await next.initialize()).toBe(false);
  expect(next.installationId).toBe(telemetry.installationId); expect(next.runId).not.toBe(telemetry.runId);
  if (process.platform !== 'win32') expect((await stat(join(storage.directory, 'telemetry.json'))).mode & 0o777).toBe(0o600);
});
it('retains bounded offline events and never sends old account answers anonymously or to another account', async () => {
  const unavailable = vi.fn().mockRejectedValue(new Error('offline')); vi.stubGlobal('fetch', unavailable);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage); await telemetry.initialize();
  await telemetry.authenticate('token-a', 'a');
  for (let index = 0; index < 510; index++) telemetry.promptAnswer('company', 'Account A');
  await telemetry.finish();
  const saved = await storage.read<{ events: unknown[] }>('telemetry'); expect(saved?.events).toHaveLength(500);
  const fetch = vi.fn().mockImplementation(async (_url, options) => Response.json({ accepted: JSON.parse(options.body).events.length })); vi.stubGlobal('fetch', fetch);
  const next = new Telemetry('https://app.docuwriter.ai', storage); await next.initialize(); await next.finish();
  expect(fetch).not.toHaveBeenCalled();
  await next.authenticate('token-b', 'b'); next.track('cli_command_started', { command: 'start' }); await next.finish();
  expect(fetch).toHaveBeenCalledTimes(1); expect(fetch.mock.calls[0][1].body).not.toContain('Account A');
  await next.authenticate('new-token-a', 'a'); await next.finish();
  const retried = fetch.mock.calls.slice(1);
  expect(retried).toHaveLength(20);
  expect(retried.every(call => call[1].headers.Authorization === 'Bearer new-token-a')).toBe(true);
  expect(retried.flatMap(call => JSON.parse(call[1].body).events)).toHaveLength(499); // The bounded buffer evicted one old event for account B's new event.
});
it('opt-out clears buffered analytics and sends no network requests even when enabled persistently', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage); await telemetry.initialize(); telemetry.track('cli_command_started');
  await telemetry.preference(false); await telemetry.finish();
  expect(await storage.read('telemetry')).toBeNull(); expect(telemetry.headers()).toEqual({ 'X-DocuWriter-Telemetry': '0' }); expect(fetch).not.toHaveBeenCalled();
  await telemetry.preference(true); vi.stubEnv('DOCUWRITER_TELEMETRY_DISABLED', '1');
  const next = new Telemetry('https://app.docuwriter.ai', storage); expect(await next.initialize()).toBe(false);
  expect(next.enabled).toBe(false); expect(await storage.read('telemetry')).toBeNull();
});
it('does not capture selected paths, filenames, or import Space names as prompt values', async () => {
  const fetch = vi.fn().mockImplementation(async (_url, options) => Response.json({ accepted: JSON.parse(options.body).events.length })); vi.stubGlobal('fetch', fetch);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage); await telemetry.initialize(); await telemetry.authenticate('token', 'a');
  telemetry.promptAnswer('documentation_locations', ['private/docs/']); telemetry.promptAnswer('documentation_path', 'secrets.md'); telemetry.promptAnswer('space_name', 'Sensitive name');
  await telemetry.finish();
  expect(fetch.mock.calls[0][1].body).not.toMatch(/private\/docs|secrets\.md|Sensitive name/);
});
it('retains the entire partially accepted batch for repeat-safe delivery', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ accepted: 1 })); vi.stubGlobal('fetch', fetch);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage); await telemetry.initialize(); await telemetry.authenticate('token', 'a');
  telemetry.track('cli_command_started', { command: 'start' }); telemetry.track('cli_command_exited', { exit_code: 0 });
  await telemetry.finish();
  expect((await storage.read<{ events: unknown[] }>('telemetry'))?.events).toHaveLength(2);
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('swallows persistence failures without changing command behavior', async () => {
  const failing = new Storage('https://app.docuwriter.ai', directory);
  vi.spyOn(failing, 'save').mockRejectedValue(new Error('permissions'));
  const telemetry = new Telemetry('https://app.docuwriter.ai', failing);
  expect(await telemetry.initialize()).toBe(false);
  expect(telemetry.enabled).toBe(false);
  await expect(telemetry.preference(false)).resolves.toBeUndefined();
  await expect(telemetry.finish()).resolves.toBeUndefined();
  vi.restoreAllMocks();
});
it('drops expired events and delivers retries with their original identifiers', async () => {
  const first = new Telemetry('https://app.docuwriter.ai', storage); await first.initialize(); await first.authenticate('token-a', 'a'); first.track('cli_command_started', { command: 'start' });
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline'))); await first.finish();
  const state = (await storage.read<{ installation_id: string; events: any[] }>('telemetry'))!;
  const original = state.events[0]; state.events.push({ ...original, event_id: crypto.randomUUID(), occurred_at: new Date(Date.now() - 8 * 86400000).toISOString() }); await storage.save('telemetry', state);
  const fetch = vi.fn().mockImplementation(async (_url, options) => Response.json({ accepted: JSON.parse(options.body).events.length })); vi.stubGlobal('fetch', fetch);
  const next = new Telemetry('https://app.docuwriter.ai', storage); await next.initialize(); await next.authenticate('token-a', 'a'); await next.finish();
  expect(JSON.parse(fetch.mock.calls[0][1].body).events).toEqual([Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'account_id'))]);
});

it('purges legacy anonymous records before login and never associates them with a later account', async () => {
  await storage.save('telemetry', { installation_id: crypto.randomUUID(), events: [{ event_id: crypto.randomUUID(), run_id: crypto.randomUUID(), sequence: 1, event: 'cli_command_started', occurred_at: new Date().toISOString(), elapsed_ms: 0, properties: {} }] });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const telemetry = new Telemetry('https://app.docuwriter.ai', storage); await telemetry.initialize();
  expect((await storage.read<{ events: unknown[] }>('telemetry'))?.events).toEqual([]);
  telemetry.track('cli_auth_started'); telemetry.promptAnswer('company', 'Before account'); await telemetry.finish();
  expect(telemetry.headers()).toEqual({ 'X-DocuWriter-Telemetry': '0' });
  expect((await storage.read<{ events: unknown[] }>('telemetry'))?.events).toEqual([]);
  await telemetry.authenticate('token', 'a'); await telemetry.finish();
  expect(fetch).not.toHaveBeenCalled();
});
