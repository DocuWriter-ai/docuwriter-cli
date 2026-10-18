import { open } from 'node:fs/promises';
import { request, retry, ApiError, failureProperties } from './http.js';
import { Storage } from './storage.js';
import type { Pending, Receipt } from './types.js';

import type { Track } from './telemetry.js';

interface Upload { token: string; part_size: number; parts: { part_number: number; url: string }[] }
export class Uploader {
  constructor(private origin: string, private token: string, private storage: Storage, private signal: AbortSignal, private track: Track = () => {}, private onStage: (stage: string) => void = () => {}) {}
  private async api<T>(path: string, method: string, body?: unknown, signal = this.signal): Promise<T> {
    return request<T>(this.origin, `/api/cli/v1${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, signal);
  }
  async abort(pending: Pending): Promise<void> {
    if (pending.token && !pending.completed) {
      try {
        await this.api(`/uploads/${encodeURIComponent(pending.token)}`, 'DELETE', undefined, AbortSignal.timeout(10_000));
      } catch (error) {
        this.track('cli_failed', failureProperties(error, 'upload_abort'));
        throw error;
      }
    }
  }
  async submit(pending: Pending, progress: (part: number, total: number) => void): Promise<Receipt> {
    if (!pending.completed) {
      // Signed part URLs expire. A restarted command starts a fresh private upload,
      // retaining the submission idempotency key and exact approved snapshot.
      if (pending.token) await this.abort(pending).catch(() => {});
      this.onStage('upload_planning');
      const upload = await this.api<Upload>('/uploads', 'POST', { file_name: `${pending.source_name}.zip`, file_size: pending.archive_size });
      if (!upload.token || !Number.isSafeInteger(upload.part_size) || upload.part_size < 1 || upload.parts.length !== Math.ceil(pending.archive_size / upload.part_size)) {
        throw new Error('DocuWriter returned an invalid upload plan.');
      }
      pending.token = upload.token;
      pending.parts = [];
      await this.storage.save('pending', pending);
      const file = await open(pending.archive, 'r');
      try {
        const sortedParts = [...upload.parts].sort((a, b) => a.part_number - b.part_number);
        for (const [index, part] of sortedParts.entries()) {
          if (part.part_number !== index + 1) throw new Error('DocuWriter returned an invalid upload plan.');
          this.signal.throwIfAborted();
          const url = new URL(part.url);
          const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
          if (url.username || url.password || (url.protocol !== 'https:' && !(local && new URL(this.origin).protocol === 'http:'))) throw new Error('DocuWriter returned an unsafe upload destination.');
          const start = index * upload.part_size;
          const buffer = Buffer.alloc(Math.min(upload.part_size, pending.archive_size - start));
          const result = await file.read(buffer, 0, buffer.length, start);
          if (result.bytesRead !== buffer.length) throw new Error('The saved snapshot is incomplete. Start a new upload.');
          this.onStage('upload_part');
          const etag = await retry(async () => {
            const response = await fetch(url, { method: 'PUT', body: buffer, redirect: 'error',
              signal: AbortSignal.any([this.signal, AbortSignal.timeout(120_000)]),
              headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(buffer.length) } });
            if (!response.ok) throw new ApiError(response.status);
            const value = response.headers.get('etag');
            if (!value) throw new Error('Storage did not confirm the uploaded part.');
            return value;
          }, this.signal, 'part');
          pending.parts.push({ part_number: part.part_number, etag });
          await this.storage.save('pending', pending);
          progress(index + 1, sortedParts.length);
        }
      } finally { await file.close(); }
      this.onStage('upload_completion');
      await retry(() => this.api(`/uploads/${encodeURIComponent(pending.token!)}/complete`, 'POST', { parts: pending.parts }), this.signal, 'completion');
      pending.completed = true;
      await this.storage.save('pending', pending);
    }
    this.track('cli_upload_completed');
    this.onStage('submission');
    return retry(() => this.api<Receipt>(pending.mode === 'import' ? '/documentation-imports' : '/submissions', 'POST', {
      idempotency_key: pending.idempotency_key, multipart_upload_token: pending.token,
      source_name: pending.source_name, ...(pending.mode === 'import' ? { space_name: pending.space_name } : pending.answers),
    }), this.signal, 'submission');
  }
}
