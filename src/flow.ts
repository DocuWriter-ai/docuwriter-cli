import * as prompts from '@clack/prompts';
import openBrowser from 'open';
import { randomUUID } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { Storage } from './storage.js';
import { Authentication } from './auth.js';
import { platformOrigin, request, sameOriginUrl, ApiError, configureTelemetry, uploadPlanLimit, failureProperties } from './http.js';
import { packageSnapshot, projectDetails, removeSnapshot, selectFiles } from './snapshot.js';
import { documentationLocations, documentationPath, selectDocumentation } from './documentation.js';
import { Uploader } from './upload.js';
import { Telemetry } from './telemetry.js';
import type { Answers, Context, Pending, Session } from './types.js';

export interface Options { cwd?: string; open: boolean; json?: boolean; analytics?: string }
class Cancelled extends Error {}
function answer<T>(value: T): Exclude<T, symbol> {
  if (prompts.isCancel(value)) throw new Cancelled('Operation cancelled.');
  return value as Exclude<T, symbol>;
}
const clean = (value: string): string => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
const size = (value: number): string => `${(value / 1024 / 1024).toFixed(1)} MB`;

async function trackedPrompt<T>(telemetry: Telemetry, key: string, operation: () => Promise<T>): Promise<Exclude<T, symbol>> {
  telemetry.track('cli_prompt_shown', { prompt: key });
  const value = answer(await operation());
  telemetry.promptAnswer(key, value);
  if (key === 'folder') telemetry.track('cli_folder_confirmed', { confirmed: Boolean(value) });
  return value;
}

async function questionnaire(context: Context, projectName: string, telemetry: Telemetry, initial?: Answers): Promise<Answers> {
  const type = await trackedPrompt(telemetry, 'documentation_type', () => prompts.select({ output: process.stderr,
    message: 'What type of documentation do you need?', initialValue: initial?.documentation_type,
    options: context.documentation_types.map(type => ({ value: type.value, label: clean(type.title), hint: clean(type.desc) })),
  }));
  const company = await trackedPrompt(telemetry, 'company', () => prompts.text({ output: process.stderr, message: 'Company or project name (optional)',
    initialValue: initial ? initial.company ?? '' : clean(projectName), validate: value => value && [...value].length > 160 ? 'Use 160 characters or fewer.' : undefined }));
  const existingSector = initial ? initial.sector : context.profile.sector;
  const sectorOptions = [...new Set([...context.sectors, ...(existingSector ? [existingSector] : [])])];
  let sector = await trackedPrompt(telemetry, 'sector', () => prompts.select({ output: process.stderr, message: 'Sector (optional)', initialValue: existingSector ?? '',
    options: [{ value: '', label: 'Not now' }, ...sectorOptions.map(value => ({ value, label: clean(value) })), { value: '__custom__', label: 'Other (enter your sector)' }] }));
  if (sector === '__custom__') sector = (await trackedPrompt(telemetry, 'sector_custom', () => prompts.text({ output: process.stderr, message: 'Your sector', validate: value => !value?.trim() ? 'Enter your sector.' : [...value].length > 120 ? 'Use 120 characters or fewer.' : undefined }))).trim();
  const goal = await trackedPrompt(telemetry, 'documentation_goal', () => prompts.text({ output: process.stderr, message: clean(context.goal.prompt),
    placeholder: 'Type your goal, or press Enter for Not now', defaultValue: '', initialValue: initial?.documentation_goal ?? '',
    validate: value => [...(value?.trim() ?? '')].length > context.goal.max_length ? `Use ${context.goal.max_length} characters or fewer.` : undefined }));
  const defaultTimezone = initial?.timezone ?? context.profile.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezoneChoice = await trackedPrompt(telemetry, 'timezone_choice', () => prompts.select({ output: process.stderr, message: 'Timezone (optional)', initialValue: initial && !initial.timezone ? 'skip' : 'current', options: [
    { value: 'current', label: clean(defaultTimezone) }, { value: 'change', label: 'Use another timezone' }, { value: 'skip', label: 'Not now' },
  ] }));
  const timezone = timezoneChoice === 'skip' ? null : timezoneChoice === 'current' ? defaultTimezone : await trackedPrompt(telemetry, 'timezone', () => prompts.text({ output: process.stderr, message: 'Timezone', initialValue: defaultTimezone,
    validate: value => { if (!value?.trim()) return 'Enter a timezone, or choose Not now.'; try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { return 'Enter an IANA timezone, for example Europe/Madrid.'; } } }));
  if (timezoneChoice === 'current') telemetry.promptAnswer('timezone', timezone);
  return { documentation_type: type, company: company.trim() || null, sector: sector || null, documentation_goal: goal?.trim() || null, timezone };
}

export async function run(command: 'start' | 'login' | 'logout' | 'analytics', options: Options): Promise<void> {
  const output = (status: string, message: string, extra: Record<string, unknown> = {}) => {
    if (options.json) process.stdout.write(`${JSON.stringify({ status, message, ...extra })}\n`);
    else process.stdout.write(`${message}\n`);
  };
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let telemetry: Telemetry | undefined;
  let stage = 'initializing';
  const retries = new Map<string, number>();
  let exitCode = 0;
  let activePending: Pending | null = null;
  let uploader: Uploader | undefined;
  let storage: Storage | undefined;
  try {
    const origin = platformOrigin();
    storage = new Storage(origin);
    await storage.initialize();
    telemetry = new Telemetry(origin, storage);
    const disclose = await telemetry.initialize();
    configureTelemetry(() => telemetry!.headers(), (attempt, error, retryStage) => {
      const properties = failureProperties(error, retryStage);
      retries.set(String(properties.stage), attempt);
      telemetry!.track('cli_upload_retry', { ...properties, attempt });
    });
    if (command === 'analytics') {
      if (options.analytics && !['on', 'off', 'status'].includes(options.analytics)) throw new Error('Use analytics on, off, or status.');
      await telemetry.preference(options.analytics === 'on' ? true : options.analytics === 'off' ? false : undefined);
      output('analytics', `CLI analytics are ${telemetry.enabled ? 'on' : 'off'}.`, { enabled: telemetry.enabled });
      return;
    }
    if (disclose) {
      process.stderr.write('After sign-in, DocuWriter tracks CLI usage, including submitted questionnaire answers, in PostHog. No anonymous analytics are collected. Disable with docuwriter analytics off or DOCUWRITER_TELEMETRY_DISABLED=1.\n');
      await telemetry.disclose();
    }
    if (command !== 'logout' && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      telemetry.track('cli_action_required', { reason: 'interactive_terminal_required' });
      output('action_required', 'Run npx docuwriter in an interactive terminal to confirm the folder, authorize your account and complete setup.');
      process.exitCode = exitCode = 2;
      return;
    }
    const authentication = new Authentication(origin, storage, abort.signal, telemetry.track);
    if (command === 'logout') { await authentication.logout(); telemetry.track('cli_command_completed', { command }); output('logged_out', 'Signed out of DocuWriter.'); return; }
    let project: Awaited<ReturnType<typeof projectDetails>> | undefined;
    if (command === 'start') {
      stage = 'folder';
      project = await projectDetails(resolve(options.cwd || process.cwd()));
      prompts.note([`Folder: ${clean(project.folder)}`, project.repository ? `Repository: ${clean(project.repository)}` : 'Local folder', project.branch ? `Branch: ${clean(project.branch)}` : '', 'Includes local edits and untracked files after exclusions. Upload starts after setup.'].filter(Boolean).join('\n'), 'Your project', { output: process.stderr });
      if (!await trackedPrompt(telemetry, 'folder', () => prompts.confirm({ output: process.stderr, message: 'Document this folder?', initialValue: false }))) throw new Cancelled('No files were uploaded.');
      const stateRelative = relative(project.folder, storage.directory);
      const projectRelative = relative(storage.directory, project.folder);
      const contains = (path: string) => !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
      if (contains(stateRelative) || contains(projectRelative)) throw new Error('Select a project outside the DocuWriter private data directory.');
    }
    const browser = async (url: string, destination: string) => {
      if (options.open) {
        try { await openBrowser(url); telemetry!.track('cli_browser_opened', { destination }); } catch (error) { telemetry!.track('cli_browser_failed', { destination, ...failureProperties(error, 'browser') }); prompts.log.info('Open the URL above in your browser to continue.', { output: process.stderr }); }
      } else telemetry!.track('cli_browser_skipped', { destination });
    };
    const authorize = async (code: string, url: string) => {
      { const verification = new URL(url); verification.searchParams.set('cli_telemetry', telemetry!.enabled ? '1' : '0'); url = verification.href; }
      prompts.note(`Code: ${clean(code)}\n${url}`, 'Continue to DocuWriter', { output: process.stderr });
      await browser(url, 'authorization');
      prompts.log.info('Waiting for you to sign in or register and approve access in your browser…', { output: process.stderr });
    };
    stage = 'authentication';
    let session = await authentication.session(authorize, command === 'login');
    const loadContext = (credentials: Session) => request<Context>(origin, '/api/cli/v1/context', { headers: { Authorization: `Bearer ${credentials.access_token}` } }, abort.signal);
    let context: Context;
    try { context = await loadContext(session); }
    catch (error) {
      if (!(error instanceof ApiError) || ![401, 403].includes(error.status)) throw error;
      await storage.remove('session');
      session = await authentication.session(authorize, true);
      context = await loadContext(session);
    }
    await telemetry.authenticate(session.access_token, context.account.id);
    telemetry.track('cli_command_started', { command });
    telemetry.track('cli_auth_completed', authentication.sessionMethod ? { method: authentication.sessionMethod } : {});
    prompts.log.info(`Signed in as ${clean(context.account.name)} (${clean(context.account.email)}).`, { output: process.stderr });
    if (command === 'login') { telemetry.track('cli_command_completed', { command }); output('authenticated', 'Signed in to DocuWriter.'); return; }
    if (!context.eligible) throw new Error('This account cannot upload a project. Continue on the platform to check your access.');
    if (context.exclusions.version !== 1) throw new Error('Update the DocuWriter CLI to use the current source exclusion rules.');
    stage = 'setup';
    uploader = new Uploader(origin, session.access_token, storage, abort.signal, telemetry.track, value => { stage = value; retries.delete(value); });
    const saved = await storage.read<Pending>('pending');
    if (saved && saved.account_id !== context.account.id) throw new Error('A pending upload belongs to another account. Sign in with that account to finish or discard it.');
    if (saved) {
      prompts.note(`Folder: ${clean(saved.folder)}\nFiles: ${saved.file_count}\nSnapshot: ${size(saved.archive_size)}`, 'Pending upload', { output: process.stderr });
      const resume = await trackedPrompt(telemetry, 'resume_upload', () => prompts.select({ output: process.stderr, message: 'Continue your previous upload?', options: [
        { value: 'resume', label: 'Resume the approved snapshot' }, { value: 'discard', label: 'Discard and start a new upload' }, { value: 'cancel', label: 'Cancel' },
      ] }));
      telemetry.track('cli_upload_resume_selected', { choice: resume });
      if (resume === 'cancel') throw new Cancelled('Pending upload saved.');
      if (resume === 'resume') activePending = saved;
      else { await uploader.abort(saved); await removeSnapshot(saved.archive, storage.directory); await storage.remove('pending'); }
    }
    if (!activePending) {
      const mode = await trackedPrompt(telemetry, 'workflow', () => prompts.select({ output: process.stderr, message: 'Do you already have documentation?', initialValue: 'generate', options: [
        { value: 'generate', label: 'Generate documentation from code' },
        { value: 'import', label: 'Import existing documentation' },
      ] }));
      telemetry.setWorkflow(mode);
      telemetry.track('cli_workflow_selected', { workflow: mode });
      if (mode === 'import' && !context.documentation_import?.enabled) throw new Error('This DocuWriter server does not support documentation imports yet.');
      let answers: Answers | undefined;
      let spaceName: string | undefined;
      let documentation: Awaited<ReturnType<typeof selectFiles>> | undefined;
      if (mode === 'import') {
        const available = await selectFiles(project!.folder, context.exclusions.patterns, Number.MAX_SAFE_INTEGER, abort.signal);
        const locations = documentationLocations(available);
        if (!locations.length) throw new Error('No Markdown documentation was found after exclusions. Add a .md or .markdown file to your project.');
        const locationsToImport = await trackedPrompt(telemetry, 'documentation_locations', () => prompts.multiselect({ output: process.stderr, message: 'Which documentation would you like to import?', required: true, options: [
          ...locations.map(value => ({ value, label: clean(value), hint: `${available.files.filter(file => /\.(md|markdown)$/i.test(file.name) && (value === '.' || file.name === value || file.name.startsWith(value))).length} pages` })),
          { value: '__custom__', label: 'Enter a documentation path' },
        ] }));
        const selectedLocations = locationsToImport.filter(location => location !== '__custom__');
        if (locationsToImport.includes('__custom__')) selectedLocations.push(await trackedPrompt(telemetry, 'documentation_path', () => prompts.text({ output: process.stderr, message: 'Documentation path (relative to project folder)',
          validate: value => documentationPath(available, value ?? '') ? undefined : 'Enter a Markdown file or folder inside this project that is not excluded.' })));
        documentation = await selectDocumentation(available, selectedLocations, context.upload.max_uncompressed_bytes ?? 20 * 1024 ** 3, abort.signal);
        telemetry.track('cli_documentation_selected', { selection_count: selectedLocations.length, file_count: documentation.files.length, page_count: documentation.files.filter(file => /\.(md|markdown)$/i.test(file.name)).length });
        spaceName = (await trackedPrompt(telemetry, 'space_name', () => prompts.text({ output: process.stderr, message: 'Space name', initialValue: clean(project!.name),
          validate: value => !value?.trim() ? 'Enter a Space name.' : [...value.trim()].length > 160 ? 'Use 160 characters or fewer.' : undefined }))).trim();
      } else answers = await questionnaire(context, project!.name, telemetry);
      stage = 'packaging';
      telemetry.track('cli_packaging_started');
      const spinner = prompts.spinner({ output: process.stderr, signal: abort.signal, onCancel: () => abort.abort() }); spinner.start('Selecting and packaging project files…');
      let snapshot: Awaited<ReturnType<typeof packageSnapshot>>;
      let selected: Awaited<ReturnType<typeof selectFiles>>;
      try {
        selected = documentation ?? await selectFiles(project!.folder, context.exclusions.patterns, context.upload.max_uncompressed_bytes ?? 20 * 1024 ** 3, abort.signal);
        snapshot = await packageSnapshot(selected, storage.directory, abort.signal);
        if (snapshot.size > context.upload.max_bytes) {
          await removeSnapshot(snapshot.archive, storage.directory);
          if (context.upload.plan_max_bytes != null && snapshot.size > context.upload.plan_max_bytes) {
            throw new ApiError(422, 'zip_upload_plan_limit', uploadPlanLimit(context.upload.plan_max_bytes, context.upload.pricing_url ?? '/pricing', origin));
          }
          throw new Error('The compressed snapshot exceeds the technical upload limit. Select a smaller folder.');
        }
        telemetry.track('cli_packaging_completed', { file_count: selected.files.length, archive_bytes: snapshot.size, excluded_count: selected.excluded });
        spinner.stop('Snapshot ready.');
      } catch (error) { spinner.stop('Packaging stopped.'); throw error; }
      activePending = { idempotency_key: randomUUID(), account_id: context.account.id, folder: project!.folder, source_name: project!.name,
        archive: snapshot.archive, archive_size: snapshot.size, file_count: selected.files.length, exclusions_version: context.exclusions.version, ...(mode === 'import' ? { mode: 'import', space_name: spaceName } : { answers }), parts: [] };
      try { await storage.save('pending', activePending); }
      catch (error) { await removeSnapshot(snapshot.archive, storage.directory); activePending = null; throw error; }
    }

    stage = 'upload';
    if (!activePending.completed && activePending.archive_size > context.upload.max_bytes) {
      if (context.upload.plan_max_bytes != null && activePending.archive_size > context.upload.plan_max_bytes) {
        throw new ApiError(422, 'zip_upload_plan_limit', uploadPlanLimit(context.upload.plan_max_bytes, context.upload.pricing_url ?? '/pricing', origin));
      }
      throw new Error('The compressed snapshot exceeds the technical upload limit. Select a smaller folder.');
    }
    telemetry.setWorkflow(activePending.mode === 'import' ? 'import' : 'generate');
    telemetry.track('cli_upload_started', { file_count: activePending.file_count, archive_bytes: activePending.archive_size, resumed: Boolean(saved && activePending === saved) });
    const spinner = prompts.spinner({ output: process.stderr, signal: abort.signal, onCancel: () => abort.abort() }); spinner.start('Uploading project snapshot…');
    let receipt;
    try { receipt = await uploader.submit(activePending, (part, total) => { telemetry!.track('cli_upload_part_completed', { part, total }); spinner.message(`Uploading snapshot: ${part}/${total} parts`); }); spinner.stop('Project uploaded successfully.'); }
    catch (error) { spinner.stop(error instanceof ApiError && error.code === 'zip_upload_plan_limit' ? 'Upload stopped: your free-plan ZIP limit was reached.' : 'Upload interrupted. Run the command again to resume the approved snapshot.'); throw error; }
    const url = sameOriginUrl(receipt.continuation_url, origin);
    if (!Number.isSafeInteger(receipt.space_id) || receipt.space_id < 1) {
      throw new Error('DocuWriter did not return a valid Space receipt. Run the command again to recover your submission.');
    }
    telemetry.track('cli_submission_received', { space_id: receipt.space_id, workflow: activePending.mode === 'import' ? 'import' : 'generate' });
    const importing = activePending.mode === 'import';
    await removeSnapshot(activePending.archive, storage.directory);
    await storage.remove('pending'); activePending = null;
    output('accepted', `${importing ? 'Documentation import started.\n' : ''}Space ID: ${receipt.space_id}\nFollow documentation progress in DocuWriter: ${url}\n${importing ? 'Keep your documentation current with Autopilot, a paid feature available in your Space.\n' : ''}You can close this terminal.`, { ...receipt, continuation_url: url });
    stage = 'handoff';
    await browser(url, 'space');
    telemetry.track('cli_command_completed', { command });
  } catch (error) {
    const cancelled = error instanceof Cancelled || abort.signal.aborted;
    if (cancelled && activePending && storage && !activePending.completed) {
      // Cancellation is explicit: abort unclaimed multipart data and remove the local archive.
      await uploader?.abort(activePending).catch(() => {});
      await removeSnapshot(activePending.archive, storage.directory).catch(() => {});
      await storage.remove('pending');
    }
    if (stage === 'authentication' && !cancelled) telemetry?.track('cli_auth_failed', { reason: 'authorization_error' });
    const failure = failureProperties(error, stage);
    telemetry?.track(cancelled ? 'cli_cancelled' : 'cli_failed', cancelled ? { stage } : { ...failure, attempt: retries.get(String(failure.stage)) ?? 0 });
    const message = error instanceof Error ? error.message.replace(/https?:\/\/[^\s]+/g, '[request URL hidden]') : 'The command could not finish.';
    const limit = error instanceof ApiError ? error.uploadLimit : undefined;
    const requestId = !cancelled && typeof failure.request_id === 'string' ? failure.request_id : undefined;
    output(cancelled ? 'cancelled' : 'error', `${clean(message)}${limit && !options.json ? `\nUpgrade plan: ${limit.pricing_url}` : ''}${requestId && !options.json ? `\nSupport reference: ${requestId}` : ''}`,
      { ...(limit ? { error: 'zip_upload_plan_limit', ...limit } : {}), ...(requestId ? { request_id: requestId } : {}) });
    process.exitCode = exitCode = cancelled ? 130 : 1;
  } finally { telemetry?.track('cli_command_exited', { exit_code: exitCode }); await telemetry?.finish(); configureTelemetry(() => ({}), () => {}); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
