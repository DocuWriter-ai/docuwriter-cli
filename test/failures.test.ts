import { afterEach, expect, it, vi } from 'vitest';
import { ApiError, failureProperties, request } from '../src/http.js';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [new ApiError(422, 'zip_upload_plan_limit'), 'packaging', 'zip_upload_plan_limit'],
  [new ApiError(401), 'submission', 'authentication_required'],
  [new ApiError(403, '/private/secret.txt'), 'submission', 'access_denied'],
  [new ApiError(408), 'part', 'request_timeout'],
  [new ApiError(429), 'part', 'rate_limited'],
  [new ApiError(503), 'completion', 'service_unavailable'],
  [new Error('private path and token'), 'packaging', 'packaging_failed'],
  [Object.assign(new Error('/private/file'), { code: 'ENOSPC' }), 'packaging', 'disk_full'],
  [new TypeError('fetch failed'), 'part', 'network_error'],
  [new TypeError('/private programming error'), 'setup', 'command_failed'],
  [new Error('https://signed.example?secret=private'), 'browser', 'browser_open_failed'],
])('reduces errors to stable safe failure properties: %#', (error, stage, code) => {
  const props = failureProperties(error, stage as string);
  expect(props.error_code).toBe(code);
  expect(JSON.stringify(props)).not.toMatch(/private|secret|signed\.example/);
});

it('preserves a backend request correlation UUID on a failed platform request', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'private_untrusted_error' }, {
    status: 422, headers: { 'X-DocuWriter-Request-Id': '12345678-1234-4567-8901-123456789012' },
  })));
  const error = await request('https://app.docuwriter.ai', '/api/cli/v1/submissions').catch(error => error);
  expect(failureProperties(error, 'submission')).toEqual({ stage: 'submission', error_code: 'validation_failed', status: 422, request_id: '12345678-1234-4567-8901-123456789012' });
});

it('does not include arbitrary backend correlation headers', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({}, { status: 503, headers: { 'X-DocuWriter-Request-Id': 'private-token' } })));
  const error = await request('https://app.docuwriter.ai', '/api/cli/v1/submissions').catch(error => error);
  expect(failureProperties(error, 'submission')).toEqual({ stage: 'submission', error_code: 'service_unavailable', status: 503 });
});
