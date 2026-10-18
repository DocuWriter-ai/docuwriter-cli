export interface Context {
  account: { id: string; name: string; email: string };
  eligible: boolean;
  documentation_import?: { enabled: boolean };
  documentation_types: { value: string; title: string; desc: string }[];
  profile: { company: string | null; sector: string | null; timezone: string | null };
  sectors: string[];
  goal: { prompt: string; max_length: number; skippable: boolean };
  upload: { max_bytes: number; part_size: number; max_label?: string; plan_max_bytes?: number | null; max_uncompressed_bytes?: number; plan_limit_message?: string; pricing_url?: string };
  exclusions: { version: number; patterns: string[] };
}
export interface AuthConfig {
  client_id: string; scope: string; device_authorization_endpoint: string;
  token_endpoint: string; revocation_endpoint: string;
}
export interface Session {
  access_token: string; refresh_token?: string; expires_at: number; client_id: string;
}
export interface Answers {
  documentation_type: string; company: string | null; sector: string | null;
  documentation_goal: string | null; timezone: string | null;
}
export interface Pending {
  idempotency_key: string; account_id: string; folder: string; archive: string; archive_size: number;
  file_count: number; exclusions_version: number; source_name: string; answers?: Answers;
  mode?: 'import'; space_name?: string;
  token?: string; completed?: boolean; parts: { part_number: number; etag: string }[];
}
export interface Receipt {
  submission_id?: string; repository_uuid?: string; import_id?: string; space_id: number; continuation_url: string; status: 'accepted';
}
