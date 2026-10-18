import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  intro: vi.fn(), outro: vi.fn(), step: vi.fn(), info: vi.fn(), success: vi.fn(),
  start: vi.fn(), advance: vi.fn(), message: vi.fn(), stop: vi.fn(), error: vi.fn(), cancel: vi.fn(), progress: vi.fn(),
}));
vi.mock('@clack/prompts', () => ({
  intro: mocks.intro, outro: mocks.outro, log: { step: mocks.step, info: mocks.info, success: mocks.success },
  progress: mocks.progress.mockImplementation(() => ({ start: mocks.start, advance: mocks.advance, message: mocks.message, stop: mocks.stop, error: mocks.error, cancel: mocks.cancel })),
}));
import { createUploadProgress, formatBytes, formatCount, sanitize, showAccepted, showProjectIntro } from '../src/presentation.js';

afterEach(() => vi.clearAllMocks());

it('removes ANSI, hyperlink escapes, control and bidirectional characters from untrusted labels', () => {
  expect(sanitize('\x1b[31mproject\x1b[0m\n\r\x00\u202e\x1b]8;;https://example.test\x07link\x1b]8;;\x07')).toBe('projectlink');
});

it('formats bytes and file counts readably without presenting invalid values', () => {
  expect(formatBytes(0)).toBe('0 B'); expect(formatBytes(1024)).toBe('1 KB');
  expect(formatBytes(1073741824)).toBe('1 GB'); expect(formatBytes(1_572_864)).toBe('1.5 MB');
  expect(formatBytes(-10)).toBe('0 B'); expect(formatBytes(Infinity)).toBe('0 B');
  expect(formatCount(1)).toBe('1 file'); expect(formatCount(1234)).toBe('1,234 files'); expect(formatCount(0, 'page')).toBe('0 pages');
});

it('introduces the exact selected folder with compact repository context on stderr', () => {
  showProjectIntro({ folder: '/projects/repo/subfolder', name: 'subfolder', repository: 'repo', branch: 'main\x1b[31m' });
  expect(mocks.intro).toHaveBeenCalledWith('DocuWriter CLI', { output: process.stderr });
  expect(mocks.step).toHaveBeenCalledWith('subfolder · Repository: repo · Branch: main', { output: process.stderr });
  expect(mocks.info).toHaveBeenCalledWith('/projects/repo/subfolder', { output: process.stderr });
});

it.each(['generate', 'import'] as const)('shows the exact accepted Space without claiming %s has completed', workflow => {
  showAccepted({ spaceId: 12, url: 'https://app.docuwriter.ai/space/12/overview', workflow });
  expect(mocks.success).toHaveBeenCalledWith(workflow === 'import' ? 'Documentation import started' : 'Documentation started', { output: process.stderr });
  expect(mocks.info).toHaveBeenCalledWith('Space 12\nhttps://app.docuwriter.ai/space/12/overview', { output: process.stderr });
  expect(mocks.info.mock.calls.some(([message]) => String(message).includes('Autopilot'))).toBe(workflow === 'import');
  expect(mocks.outro).toHaveBeenCalledWith('Continue in your Space. You can close this terminal.', { output: process.stderr });
});

it('advances only by confirmed bytes and keeps failures distinct from success', () => {
  const bar = createUploadProgress(10_000);
  bar.start(); bar.update(6000); bar.update(6000); bar.update(4000); bar.message('Confirming upload…'); bar.error('Upload stopped.');
  expect(mocks.progress.mock.calls[0][0]).toMatchObject({ output: process.stderr, max: 10_000 });
  expect(mocks.advance.mock.calls.map(([bytes]) => bytes)).toEqual([6000, 0, 0]);
  expect(mocks.message).toHaveBeenCalledWith('Confirming upload…');
  expect(mocks.error).toHaveBeenCalledWith('Upload stopped.'); expect(mocks.stop).not.toHaveBeenCalled();
  expect(mocks.advance.mock.calls.every(([, label]) => String(label).includes('5.9 KB / 9.8 KB'))).toBe(true);
});

it('clamps completed bytes to the snapshot size and supports explicit cancellation', () => {
  const bar = createUploadProgress(1024); bar.start(); bar.update(4000); bar.cancel('Cancelled.');
  expect(mocks.advance).toHaveBeenCalledWith(1024, expect.stringContaining('1 KB / 1 KB'));
  expect(mocks.cancel).toHaveBeenCalledWith('Cancelled.'); expect(mocks.stop).not.toHaveBeenCalled();
});

it('fits the progress bar to a narrow terminal', () => {
  const columns = Object.getOwnPropertyDescriptor(process.stderr, 'columns');
  Object.defineProperty(process.stderr, 'columns', { configurable: true, value: 40 });
  try {
    const bar = createUploadProgress(1073741824); bar.start();
    const options = mocks.progress.mock.calls[0][0];
    expect(options.size).toBeGreaterThanOrEqual(1); expect(options.size).toBeLessThan(28);
    expect(mocks.start).toHaveBeenCalledWith('0% · 0 B / 1 GB');
  } finally {
    if (columns) Object.defineProperty(process.stderr, 'columns', columns);
    else delete (process.stderr as { columns?: number }).columns;
  }
});

it('suppresses every decorative output and progress object in JSON mode', () => {
  showProjectIntro({ folder: '/project', name: 'project' }, true);
  showAccepted({ spaceId: 1, url: 'https://app.docuwriter.ai/space/1/overview', workflow: 'import' }, true);
  const bar = createUploadProgress(1024, { json: true });
  bar.start(); bar.update(1024); bar.message('Waiting'); bar.stop(); bar.error('Failed'); bar.cancel('Cancelled');
  for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
});


it('shows a percentage computed only from acknowledged bytes', () => {
  const bar = createUploadProgress(10_000); bar.start(); bar.update(2500); bar.update(9999);
  expect(mocks.advance.mock.calls[0][1]).toContain('25% ·');
  expect(mocks.advance.mock.calls[1][1]).toContain('99% ·');
  expect(mocks.advance.mock.calls[1][1]).not.toContain('100%');
  bar.update(10_000); expect(mocks.advance.mock.calls[2][1]).toContain('100% ·');
});

it('does not write duplicate endings after Clack automatically handles cancellation', () => {
  const onCancel = vi.fn(); const bar = createUploadProgress(1024, { onCancel }); bar.start();
  mocks.progress.mock.calls[0][0].onCancel();
  bar.cancel('Cancelled'); bar.error('Failed'); bar.stop(); bar.message('Waiting'); bar.update(1024);
  expect(onCancel).toHaveBeenCalledOnce(); expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.error).not.toHaveBeenCalled();
  expect(mocks.stop).not.toHaveBeenCalled(); expect(mocks.message).not.toHaveBeenCalled(); expect(mocks.advance).not.toHaveBeenCalled();
});

it('suppresses updates and additional endings after abort or explicit completion', () => {
  const signal = new AbortController(); const bar = createUploadProgress(1024, { signal: signal.signal }); bar.start(); signal.abort();
  bar.error('Failed'); bar.cancel('Cancelled'); expect(mocks.error).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  const finished = createUploadProgress(1024); finished.start(); finished.stop('Accepted'); finished.error('Late failure'); finished.stop('Again');
  expect(mocks.stop).toHaveBeenCalledExactlyOnceWith('Accepted'); expect(mocks.error).not.toHaveBeenCalled();
});
