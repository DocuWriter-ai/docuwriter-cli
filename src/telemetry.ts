import { randomUUID } from 'node:crypto';
import { platform } from 'node:os';
import { Storage } from './storage.js';

export const cliVersion = '0.1.0';
interface Event { event_id: string; run_id: string; sequence: number; event: string; occurred_at: string; elapsed_ms: number; properties: Record<string, unknown>; account_id?: string }
interface BufferState { installation_id: string; events: Event[] }
export type Track = (event: string, properties?: Record<string, unknown>) => void;
const maximumAge = 7 * 24 * 60 * 60 * 1000;
const safeValues = new Set(['company', 'sector', 'sector_custom', 'documentation_goal', 'timezone', 'documentation_type']);

export class Telemetry {
  readonly runId = randomUUID();
  installationId: string = randomUUID();
  enabled = false;
  private sequence = 0;
  private started = Date.now();
  private events: Event[] = [];
  private writes = Promise.resolve();
  private writeScheduled = false;
  private token?: string;
  private accountId?: string;
  private workflow?: string;
  constructor(private origin: string, private storage: Storage) {}
  async initialize(): Promise<boolean> {
    try {
      const preference = await this.storage.read<{ enabled: boolean; disclosed?: boolean }>('analytics');
      const state = await this.storage.read<BufferState>('telemetry');
      if (state && /^[0-9a-f-]{36}$/i.test(state.installation_id)) this.installationId = state.installation_id;
      this.enabled = process.env.DOCUWRITER_TELEMETRY_DISABLED !== '1' && preference?.enabled !== false;
      this.events = this.enabled && state ? state.events.filter(event => typeof event.account_id === 'string' && event.account_id.length > 0 && Date.parse(event.occurred_at) > Date.now() - maximumAge).slice(-500) : [];
      if (!this.enabled) await this.storage.remove('telemetry');
      else await this.persist();
      return this.enabled && !preference?.disclosed;
    } catch { this.enabled = false; return false; }
  }
  async disclose(): Promise<void> { try { await this.storage.save('analytics', { enabled: true, disclosed: true }); } catch {} }
  async preference(value?: boolean): Promise<void> {
    if (value !== undefined) {
      try { await this.storage.save('analytics', { enabled: value, disclosed: value }); } catch {}
      this.enabled = value && process.env.DOCUWRITER_TELEMETRY_DISABLED !== '1';
      if (!this.enabled) { this.events = []; await this.writes; try { await this.storage.remove('telemetry'); } catch {} }
    }
  }
  headers(): Record<string, string> {
    return this.enabled && this.token && this.accountId ? { 'X-DocuWriter-Telemetry': '1', 'X-DocuWriter-Run-Id': this.runId, 'X-DocuWriter-Installation-Id': this.installationId, ...(this.workflow ? { 'X-DocuWriter-Workflow': this.workflow } : {}) } : { 'X-DocuWriter-Telemetry': '0' };
  }
  setWorkflow(value: string): void { this.workflow = value; }
  async authenticate(token: string, accountId: string): Promise<void> {
    if (!token || !accountId) return;
    await this.flush();
    this.token = token;
    this.accountId = accountId;
  }
  track: Track = (event, properties = {}) => {
    if (!this.enabled || !this.token || !this.accountId) return;
    const now = Date.now();
    this.events.push({ event_id: randomUUID(), run_id: this.runId, sequence: ++this.sequence, event, occurred_at: new Date(now).toISOString(), elapsed_ms: now - this.started, account_id: this.accountId, properties: { ...this.workflow ? { workflow: this.workflow } : {}, ...properties } });
    this.events = this.events.filter(item => Date.parse(item.occurred_at) > now - maximumAge).slice(-500);
    if (!this.writeScheduled) {
      this.writeScheduled = true;
      this.writes = this.writes.then(async () => { this.writeScheduled = false; await this.persist(); }).catch(() => {});
    }
  };
  promptAnswer(prompt: string, value: unknown): void {
    if (safeValues.has(prompt) && typeof value === 'string') value = value.trim();
    const skip = value === '' || value === null || value === 'skip';
    this.track(skip ? 'cli_prompt_skipped' : 'cli_prompt_answered', { prompt, ...(!skip && this.token && safeValues.has(prompt) && value !== '__custom__' ? { value } : {}) });
  }
  private async persist(): Promise<void> { await this.storage.save('telemetry', { installation_id: this.installationId, events: this.events }); }
  async flush(): Promise<void> {
    if (!this.enabled || !this.token || !this.accountId) return;
    await this.writes;
    const signal = AbortSignal.timeout(2000);
    try {
      while (!signal.aborted) {
        const batch = this.events.filter(event => event.account_id === this.accountId).slice(0, 25);
        if (!batch.length) break;
        const response = await fetch(`${this.origin}/api/cli/v1/events`, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'Content-Type': 'application/json', ...this.headers(), Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ installation_id: this.installationId, cli_version: cliVersion, os: platform(), events: batch.map(({ account_id, ...event }) => event) }),
        });
        if (!response.ok) break;
        const receipt = await response.json().catch(() => null) as { accepted?: number } | null;
        if (!receipt || typeof receipt.accepted !== 'number' || receipt.accepted < batch.length) break;
        const sent = new Set(batch.map(event => event.event_id));
        this.events = this.events.filter(event => !sent.has(event.event_id));
      }
      await this.persist();
    } catch {}
  }

  async finish(): Promise<void> { await this.flush(); }
}
