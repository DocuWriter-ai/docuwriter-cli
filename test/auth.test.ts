import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Authentication } from '../src/auth.js';
import { Storage } from '../src/storage.js';
const origin = 'https://app.docuwriter.ai';
const config = { client_id: 'public-cli', scope: 'cli:submit', device_authorization_endpoint: `${origin}/oauth/device/code`, token_endpoint: `${origin}/oauth/token`, revocation_endpoint: `${origin}/api/cli/v1/auth/revoke` };
const temporary: string[] = [];
async function setup() {
  const path = await mkdtemp(join(tmpdir(), 'docuwriter-auth-test-')); temporary.push(path);
  const storage = new Storage(origin, path); await storage.initialize();
  return { storage, auth: new Authentication(origin, storage, new AbortController().signal) };
}
afterEach(async () => { vi.unstubAllGlobals(); vi.useRealTimers(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('reuses an unexpired origin-isolated session without any requests', async () => {
  const { auth, storage } = await setup();
  const session = { access_token: 'token', expires_at: Date.now() + 100_000, client_id: 'public-cli' };
  await storage.save('session', session);
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  expect(await auth.session(vi.fn())).toEqual(session);
  expect(fetch).not.toHaveBeenCalled();
  expect(new Storage('http://localhost:8000', join(storage.directory, '..')).directory).not.toBe(storage.directory);
  if (process.platform !== 'win32') expect((await stat(join(storage.directory, 'session.json'))).mode & 0o777).toBe(0o600);
});
it('refreshes an expired session and revokes the refreshed session on logout', async () => {
  const { auth, storage } = await setup();
  await storage.save('session', { access_token: 'expired', refresh_token: 'refresh', expires_at: 0, client_id: 'public-cli' });
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 3600 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  await auth.logout();
  expect((fetch.mock.calls[1][1].body as URLSearchParams).get('grant_type')).toBe('refresh_token');
  expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer fresh');
  expect(await storage.read('session')).toBeNull();
});
it('rejects foreign OAuth destinations before sending a device request', async () => {
  const { auth } = await setup();
  const fetch = vi.fn().mockResolvedValue(Response.json({ ...config, token_endpoint: 'https://other.example/token' }));
  vi.stubGlobal('fetch', fetch);
  await expect(auth.session(vi.fn())).rejects.toThrow('unexpected destination');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('supports device pending and slow_down before receiving credentials', async () => {
  const { auth, storage } = await setup();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ device_code: 'device', user_code: 'ABCD-EFGH', verification_uri_complete: `${origin}/oauth/device?user_code=ABCD-EFGH`, expires_in: 60, interval: 1 }))
    .mockResolvedValueOnce(Response.json({ error: 'authorization_pending' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ error: 'slow_down' }, { status: 400 }))
    .mockResolvedValueOnce(Response.json({ access_token: 'approved', refresh_token: 'refresh', expires_in: 3600 }));
  vi.stubGlobal('fetch', fetch);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const show = vi.fn();
  const result = auth.session(show);
  await vi.waitFor(() => expect(show).toHaveBeenCalled());
  await vi.advanceTimersByTimeAsync(8000);
  expect((await result).access_token).toBe('approved');
  expect((await storage.read<{ access_token: string }>('session'))?.access_token).toBe('approved');
});
it('stops on denied authorization without saving credentials', async () => {
  const { auth, storage } = await setup();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(config))
    .mockResolvedValueOnce(Response.json({ device_code: 'device', user_code: 'ABCD', verification_uri: `${origin}/oauth/device`, expires_in: 60, interval: 1 }))
    .mockResolvedValueOnce(Response.json({ error: 'access_denied' }, { status: 400 })));
  const result = auth.session(vi.fn());
  await expect(result).rejects.toThrow('declined');
  expect(await storage.read('session')).toBeNull();
});
