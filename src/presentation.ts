import * as prompts from '@clack/prompts';
import { stripVTControlCharacters } from 'node:util';

export function sanitize(value: string): string {
  return stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '');
}

const safeNumber = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

export function formatBytes(bytes: number): string {
  const value = safeNumber(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = value ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024))) : 0;
  const amount = value / 1024 ** index;
  return `${index === 0 ? amount : Number(amount.toFixed(1))} ${units[index]}`;
}

export function formatCount(count: number, label = 'file'): string {
  const value = safeNumber(count);
  return `${new Intl.NumberFormat('en-US').format(value)} ${sanitize(label)}${value === 1 ? '' : 's'}`;
}

export function showProjectIntro(project: { folder: string; name: string; repository?: string; branch?: string }, json = false): void {
  if (json) return;
  const output = process.stderr;
  prompts.intro('DocuWriter CLI', { output });
  prompts.log.step([sanitize(project.name), project.repository && project.repository !== project.name ? `Repository: ${sanitize(project.repository)}` : '', project.branch ? `Branch: ${sanitize(project.branch)}` : ''].filter(Boolean).join(' · '), { output });
  prompts.log.info(sanitize(project.folder), { output });
  prompts.log.info('Includes local edits and untracked files after exclusions. Upload starts after setup.', { output });
}

export function showAccepted(receipt: { spaceId: number; url: string; workflow: 'generate' | 'import' }, json = false): void {
  if (json) return;
  const output = process.stderr;
  prompts.log.success(receipt.workflow === 'import' ? 'Documentation import started' : 'Documentation started', { output });
  prompts.log.info(`Space ${safeNumber(receipt.spaceId)}\n${sanitize(receipt.url)}`, { output });
  if (receipt.workflow === 'import') prompts.log.info('Autopilot keeps documentation current. Available with a paid plan in your Space.', { output });
  prompts.outro('Continue in your Space. You can close this terminal.', { output });
}

export interface UploadProgress {
  start(): void;
  update(completedBytes: number): void;
  message(text: string): void;
  stop(text?: string): void;
  error(text: string): void;
  cancel(text: string): void;
}

export function createUploadProgress(totalBytes: number, options: { signal?: AbortSignal; json?: boolean; onCancel?: () => void } = {}): UploadProgress {
  if (options.json) return { start() {}, update() {}, message() {}, stop() {}, error() {}, cancel() {} };
  const total = safeNumber(totalBytes);
  const columns = process.stderr.columns || 80;
  const prefix = columns < 60 ? '' : 'Uploading ';
  const label = (bytes: number) => `${prefix}${total ? Math.floor(bytes / total * 100) : 0}% · ${formatBytes(bytes)} / ${formatBytes(total)}`;
  const labelWidth = Math.max(label(total).length, label(Math.max(0, total - 1)).length, label(total / 2).length);
  const size = Math.max(1, Math.min(28, columns - 8 - labelWidth));
  let settled = false;
  const bar = prompts.progress({ output: process.stderr, signal: options.signal, onCancel: () => { settled = true; options.onCancel?.(); }, max: Math.max(1, total), size, style: 'light' });
  const inactive = () => settled || options.signal?.aborted || bar.isCancelled;
  const finish = (method: 'stop' | 'error' | 'cancel', text: string) => {
    if (inactive()) return;
    settled = true;
    bar[method](sanitize(text));
  };
  let completed = 0;
  return {
    start: () => { if (!inactive()) bar.start(label(completed)); },
    update: bytes => {
      if (inactive()) return;
      const next = Math.min(total, Math.max(completed, safeNumber(bytes)));
      bar.advance(next - completed, label(next));
      completed = next;
    },
    message: text => { if (!inactive()) bar.message(sanitize(text)); },
    stop: (text = 'Project uploaded successfully.') => finish('stop', text),
    error: text => finish('error', text),
    cancel: text => finish('cancel', text),
  };
}
