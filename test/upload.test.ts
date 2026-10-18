import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Uploader } from '../src/upload.js';
import { ApiError } from '../src/http.js';
import { Storage } from '../src/storage.js';
import type { Pending } from '../src/types.js';
const temporary: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'docuwriter-upload-test-')); temporary.push(directory);
  const storage = new Storage('https://app.docuwriter.ai', directory); await storage.initialize();
  const path = join(storage.directory, 'source.zip'); await writeFile(path, 'abcdef');
  const pending: Pending = { idempotency_key: 'stable-id', account_id: 'account-uuid', folder: '/project', archive: path, archive_size: 6, file_count: 1, exclusions_version: 1, source_name: 'project', answers: { documentation_type: 'internal', company: null, sector: null, timezone: 'Europe/Madrid', documentation_goal: 'Onboard developers' }, parts: [] };
  return { pending, storage, uploader: new Uploader('https://app.docuwriter.ai', 'platform-token', storage, new AbortController().signal) };
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it('uploads signed parts without authorization and preserves identity across a lost acceptance response', async () => {
  const { uploader, pending, storage } = await setup();
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ token: 'upload', part_size: 3, parts: [{ part_number: 1, url: 'https://storage.example/one' }, { part_number: 2, url: 'https://storage.example/two' }] }))
    .mockResolvedValueOnce(new Response(null, { headers: { etag: 'one' } }))
    .mockResolvedValueOnce(new Response(null, { headers: { etag: 'two' } }))
    .mockResolvedValueOnce(Response.json({ completed: true }))
    .mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockResolvedValueOnce(Response.json({ status: 'accepted', submission_id: 'stable-id', repository_uuid: 'repo', space_id: 123, continuation_url: 'https://app.docuwriter.ai/spaces/123' }));
  vi.stubGlobal('fetch', fetch);
  const progress = vi.fn(); const receipt = await uploader.submit(pending, progress);
  expect(receipt.status).toBe('accepted');
  expect(receipt.space_id).toBe(123);
  expect(receipt.continuation_url).toBe('https://app.docuwriter.ai/spaces/123');
  expect(progress.mock.calls).toEqual([[1, 2], [2, 2]]);
  expect(fetch.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/octet-stream', 'Content-Length': '3' });
  expect(fetch.mock.calls[4][1].body).toBe(fetch.mock.calls[5][1].body);
  expect(JSON.parse(fetch.mock.calls[5][1].body).idempotency_key).toBe('stable-id');
  expect((await storage.read<Pending>('pending'))?.completed).toBe(true);
});
it('replays a completed submission without rereading or reuploading its archive', async () => {
  const { uploader, pending } = await setup(); pending.completed = true; pending.token = 'completed';
  await rm(pending.archive);
  const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'accepted', submission_id: 'stable-id', repository_uuid: 'repo', space_id: 123, continuation_url: 'https://app.docuwriter.ai/spaces/123' }));
  vi.stubGlobal('fetch', fetch);
  await uploader.submit(pending, vi.fn());
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('https://app.docuwriter.ai/api/cli/v1/submissions');
});
it('does not retry invalid submissions', async () => {
  const { uploader, pending } = await setup(); pending.completed = true; pending.token = 'completed';
  const fetch = vi.fn().mockResolvedValue(Response.json({}, { status: 422 })); vi.stubGlobal('fetch', fetch);
  await expect(uploader.submit(pending, vi.fn())).rejects.toThrow('HTTP 422');
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('resumes an import with its original identity and import endpoint without generation answers', async () => {
  const { uploader, pending } = await setup();
  pending.mode = 'import'; pending.space_name = 'Existing docs'; pending.completed = true; pending.token = 'completed';
  const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'accepted', import_id: 'stable-id', space_id: 9, continuation_url: 'https://app.docuwriter.ai/space/9/overview' }));
  vi.stubGlobal('fetch', fetch);
  const receipt = await uploader.submit(pending, vi.fn());
  expect(receipt.import_id).toBe('stable-id');
  expect(fetch.mock.calls[0][0]).toBe('https://app.docuwriter.ai/api/cli/v1/documentation-imports');
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ idempotency_key: 'stable-id', multipart_upload_token: 'completed', source_name: 'project', space_name: 'Existing docs' });
});


it('preserves a server plan-limit rejection on a completed resumed submission without retrying', async () => {
  const { uploader, pending } = await setup(); pending.completed = true; pending.token = 'completed';
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'zip_upload_plan_limit', message: 'untrusted response text', max_bytes: 1073741824, pricing_url: '/pricing' }, { status: 422 }));
  vi.stubGlobal('fetch', fetch);
  const error = await uploader.submit(pending, vi.fn()).catch(error => error);
  expect(error).toBeInstanceOf(ApiError);
  expect(error.message).toBe('Your free plan supports ZIP uploads up to 1 GB. Upgrade to upload larger projects.');
  expect(error.uploadLimit).toMatchObject({ max_bytes: 1073741824, pricing_url: 'https://app.docuwriter.ai/pricing', upgrade_required: true });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('rejects external upgrade destinations without exposing them', async () => {
  const { uploader, pending } = await setup(); pending.completed = true; pending.token = 'completed';
  const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'zip_upload_plan_limit', max_bytes: 1073741824, pricing_url: 'https://attacker.example/phishing' }, { status: 422 }));
  vi.stubGlobal('fetch', fetch);
  await expect(uploader.submit(pending, vi.fn())).rejects.toThrow('HTTP 422');
  expect(fetch).toHaveBeenCalledTimes(1);
});


it('records a sanitized abort failure even when callers discard cleanup errors', async () => {
  const { pending, storage } = await setup(); pending.token = 'private-upload-token';
  const track = vi.fn();
  const uploader = new Uploader('https://app.docuwriter.ai', 'platform-token', storage, new AbortController().signal, track);
  const fetch = vi.fn().mockRejectedValue(new Error('https://private-storage.example?secret=signed-token'));
  vi.stubGlobal('fetch', fetch);
  await uploader.abort(pending).catch(() => {});
  expect(track).toHaveBeenCalledExactlyOnceWith('cli_failed', { stage: 'upload_abort', error_code: 'upload_abort_failed' });
  expect(JSON.stringify(track.mock.calls)).not.toMatch(/private|secret|signed-token|platform-token/);
  expect(fetch).toHaveBeenCalledTimes(1);
});
