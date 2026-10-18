let telemetryHeaders: () => Record<string, string> = () => ({});
let retryEvent: (attempt: number, error: unknown, stage: string) => void = () => {};
export function configureTelemetry(headers: () => Record<string, string>, onRetry: typeof retryEvent): void { telemetryHeaders = headers; retryEvent = onRetry; }
export const defaultOrigin = 'https://app.docuwriter.ai';

export function platformOrigin(environment = process.env): string {
  const input = environment.DOCUWRITER_API_URL || defaultOrigin;
  const url = new URL(input);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.test');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.origin !== defaultOrigin && !(environment.DOCUWRITER_ALLOW_LOCAL === '1' && local && ['http:', 'https:'].includes(url.protocol)))) {
    throw new Error('Use the official DocuWriter origin, or explicitly enable a local development origin.');
  }
  return url.origin;
}

export function sameOriginUrl(input: string, origin: string): string {
  const url = new URL(input, origin);
  if (url.origin !== origin || url.username || url.password) throw new Error('DocuWriter returned an unexpected destination.');
  return url.href;
}

export const zipPlanLimitMessage = 'Your free plan supports ZIP uploads up to 1 GB. Upgrade to upload larger projects.';
export interface UploadPlanLimit { max_bytes: number; max_label: string; upgrade_required: true; pricing_url: string }

export function uploadPlanLimit(maximumBytes: number, pricingUrl: string, origin: string): UploadPlanLimit {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) throw new Error('DocuWriter returned an invalid upload limit.');
  return { max_bytes: maximumBytes, max_label: '1 GB', upgrade_required: true, pricing_url: sameOriginUrl(pricingUrl, origin) };
}

export class ApiError extends Error {
  constructor(public status: number, public code?: string, public uploadLimit?: UploadPlanLimit, public requestId?: string) {
    super(code === 'zip_upload_plan_limit' && uploadLimit ? zipPlanLimitMessage : status === 401 ? 'Your CLI session has expired. Run docuwriter login and try again.' : `DocuWriter could not complete this request (HTTP ${status}).`);
  }
}

export function failureProperties(error: unknown, stage: string): Record<string, string | number> {
  const phase = ({ part: 'upload_part', completion: 'upload_completion' } as Record<string, string>)[stage] ?? stage;
  let code = ({ packaging: 'packaging_failed', upload_abort: 'upload_abort_failed', upload_planning: 'upload_plan_failed', upload_part: 'upload_part_failed', upload_completion: 'upload_completion_failed', submission: 'submission_failed', browser: 'browser_open_failed' } as Record<string, string>)[phase] ?? 'command_failed';
  if (error instanceof ApiError) {
    code = error.code === 'zip_upload_plan_limit' ? 'zip_upload_plan_limit'
      : ({ 401: 'authentication_required', 403: 'access_denied', 408: 'request_timeout', 413: 'snapshot_too_large', 422: 'validation_failed', 429: 'rate_limited' } as Record<number, string>)[error.status]
        ?? (error.status >= 500 ? 'service_unavailable' : 'api_request_failed');
  } else if (error instanceof Error) {
    const nodeCode = (error as NodeJS.ErrnoException).code;
    code = ({ ENOSPC: 'disk_full', EACCES: 'file_access_denied', EPERM: 'file_access_denied', ENOENT: 'file_missing', ECONNRESET: 'network_error', ECONNREFUSED: 'network_error', ENOTFOUND: 'network_error', ETIMEDOUT: 'request_timeout' } as Record<string, string>)[nodeCode ?? '']
      ?? (error.name === 'TimeoutError' ? 'request_timeout' : error instanceof TypeError && error.message === 'fetch failed' && phase !== 'browser' ? 'network_error' : code);
  }
  return { stage: /^[a-z][a-z0-9_]{0,63}$/.test(phase) ? phase : 'unknown', error_code: code, ...(error instanceof ApiError ? { status: error.status, ...(error.requestId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(error.requestId) ? { request_id: error.requestId } : {}) } : {}) };
}

export const delay = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  signal?.throwIfAborted();
  const onAbort = () => { clearTimeout(timer); reject(new Error('Operation cancelled.')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, milliseconds);
  signal?.addEventListener('abort', onAbort, { once: true });
});

export async function retry<T>(operation: () => Promise<T>, signal?: AbortSignal, stage = 'transfer'): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); } catch (error) {
      if (signal?.aborted || attempt >= 3 || (error instanceof ApiError && error.status !== 408 && error.status !== 429 && error.status < 500)) throw error;
      retryEvent(attempt + 1, error, stage);
      await delay(500 * 2 ** attempt, signal);
    }
  }
}

export async function request<T>(origin: string, path: string, options: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(sameOriginUrl(path, origin), {
    ...options, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000),
    headers: { Accept: 'application/json', ...telemetryHeaders(), ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string; max_bytes?: number; pricing_url?: string };
    let limit: UploadPlanLimit | undefined;
    if (body.error === 'zip_upload_plan_limit' && typeof body.max_bytes === 'number' && typeof body.pricing_url === 'string') {
      try { limit = uploadPlanLimit(body.max_bytes, body.pricing_url, origin); }
      catch { throw new ApiError(response.status); }
    }
    const requestId = response.headers.get('X-DocuWriter-Request-Id') ?? undefined;
    throw new ApiError(response.status, body.error, limit, requestId);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
