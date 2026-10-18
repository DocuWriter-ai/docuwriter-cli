import { request, ApiError, delay, sameOriginUrl } from './http.js';
import { Storage } from './storage.js';
import type { AuthConfig, Session } from './types.js';

import type { Track } from './telemetry.js';

interface Tokens { access_token: string; refresh_token?: string; expires_in: number }
interface DeviceCode { device_code: string; user_code: string; verification_uri: string; verification_uri_complete?: string; expires_in: number; interval?: number }
export class Authentication {
  sessionMethod?: 'saved_session' | 'refresh' | 'device';
  constructor(private origin: string, private storage: Storage, private signal: AbortSignal, private track: Track = () => {}) {}
  async configuration(): Promise<AuthConfig> {
    const config = await request<AuthConfig>(this.origin, '/api/cli/v1/auth/config', {}, this.signal);
    for (const endpoint of [config.device_authorization_endpoint, config.token_endpoint, config.revocation_endpoint]) sameOriginUrl(endpoint, this.origin);
    return config;
  }
  private async exchange(config: AuthConfig, values: Record<string, string>): Promise<Session> {
    const tokens = await request<Tokens>(this.origin, config.token_endpoint, {
      method: 'POST', body: new URLSearchParams({ client_id: config.client_id, ...values }),
    }, this.signal);
    const session = { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000, client_id: config.client_id };
    await this.storage.save('session', session);
    return session;
  }
  async session(showAuthorization: (code: string, url: string) => Promise<void>, force = false): Promise<Session> {
    let saved = await this.storage.read<Session>('session');
    if (!force && saved && saved.expires_at > Date.now() + 60_000) { this.sessionMethod = 'saved_session'; this.track('cli_auth_completed', { method: 'saved_session' }); return saved; }
    const config = await this.configuration();
    if (!force && saved?.refresh_token && saved.client_id === config.client_id) {
      try { this.track('cli_auth_started', { method: 'refresh' }); const session = await this.exchange(config, { grant_type: 'refresh_token', refresh_token: saved.refresh_token, scope: config.scope }); this.sessionMethod = 'refresh'; this.track('cli_auth_completed', { method: 'refresh' }); return session; }
      catch (error) { if (!(error instanceof ApiError) || ![400, 401].includes(error.status)) throw error; }
    }
    this.track('cli_auth_started', { method: 'device' });
    const code = await request<DeviceCode>(this.origin, config.device_authorization_endpoint, {
      method: 'POST', body: new URLSearchParams({ client_id: config.client_id, scope: config.scope }),
    }, this.signal);
    await showAuthorization(code.user_code, sameOriginUrl(code.verification_uri_complete || code.verification_uri, this.origin));
    const deadline = Date.now() + code.expires_in * 1000;
    let interval = Math.max(1, code.interval || 5) * 1000;
    while (Date.now() < deadline) {
      await delay(interval, this.signal);
      if (Date.now() >= deadline) break;
      try { const session = await this.exchange(config, { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: code.device_code }); this.sessionMethod = 'device'; this.track('cli_auth_completed', { method: 'device' }); return session; }
      catch (error) {
        if (error instanceof ApiError && error.code === 'authorization_pending') continue;
        if (error instanceof ApiError && error.code === 'slow_down') { interval += 5000; continue; }
        if (error instanceof ApiError && error.code === 'access_denied') throw new Error('Authorization was declined.');
        if (error instanceof ApiError && error.code === 'expired_token') break;
        throw error;
      }
    }
    throw new Error('Authorization expired. Run the command again to get a new code.');
  }
  async logout(): Promise<void> {
    let saved = await this.storage.read<Session>('session');
    if (saved) {
      const config = await this.configuration();
      if (saved.expires_at <= Date.now() + 60_000 && saved.refresh_token) {
        try { saved = await this.exchange(config, { grant_type: 'refresh_token', refresh_token: saved.refresh_token, scope: config.scope }); }
        catch (error) { if (!(error instanceof ApiError) || ![400, 401].includes(error.status)) throw error; }
      }
      try { await request<void>(this.origin, config.revocation_endpoint, { method: 'POST', headers: { Authorization: `Bearer ${saved.access_token}` } }, this.signal); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 401) throw error; }
    }
    await this.storage.remove('session');
  }
}
