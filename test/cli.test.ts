import { expect, it } from 'vitest';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { platformOrigin, sameOriginUrl } from '../src/http.js';
const execute = promisify(execFile);
it('returns action_required without authentication or upload in a non-interactive terminal', async () => {
  try {
    await execute(process.execPath, ['dist/index.js', '--json'], { env: { ...process.env, DOCUWRITER_TELEMETRY_DISABLED: '1' } });
    throw new Error('Expected exit code 2');
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    expect(result.code).toBe(2);
    expect(JSON.parse(result.stdout).status).toBe('action_required');
    expect(result.stderr).toBe('');
  }
});
it('provides help and version without an interactive terminal', async () => {
  expect((await execute(process.execPath, ['dist/index.js', '--version'], { env: { ...process.env, DOCUWRITER_TELEMETRY_DISABLED: '1' } })).stdout.trim()).toBe('0.1.0');
  expect((await execute(process.execPath, ['dist/index.js', '--help'], { env: { ...process.env, DOCUWRITER_TELEMETRY_DISABLED: '1' } })).stdout).toContain('--cwd');
});
it('permits only the production origin or explicitly enabled local development origins', () => {
  expect(platformOrigin({})).toBe('https://app.docuwriter.ai');
  expect(() => platformOrigin({ DOCUWRITER_API_URL: 'https://attacker.example' })).toThrow();
  expect(() => platformOrigin({ DOCUWRITER_API_URL: 'http://localhost:8000' })).toThrow();
  expect(platformOrigin({ DOCUWRITER_API_URL: 'http://localhost:8000', DOCUWRITER_ALLOW_LOCAL: '1' })).toBe('http://localhost:8000');
  expect(() => sameOriginUrl('https://other.example', 'https://app.docuwriter.ai')).toThrow();
});
