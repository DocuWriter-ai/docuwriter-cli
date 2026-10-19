# DocuWriter CLI

Start documentation from your current project, then continue on DocuWriter. The CLI is deterministic: it does not run a model or generate documentation locally.

This package is under development and has **not been published**. The intended command is `npx docuwriter`; npm package ownership must be confirmed before publication.

## Intended installation

Once published, run `npx docuwriter` in your project directory. The package is not available yet. The `docuwriter-ai` npm organization does not reserve this unscoped name; an organization-scoped alternative would be `@docuwriter-ai/cli`.

The CLI is proprietary (`UNLICENSED`); public package distribution does not grant an open-source license. Source and issue tracking: [DocuWriter-ai/docuwriter-cli](https://github.com/DocuWriter-ai/docuwriter-cli).

## Local development

Requires Node.js 22.18 or later.

```sh
npm ci
npm run build
node dist/index.js --cwd /absolute/path/to/project
```

The guide confirms the exact directory, opens browser sign-in or registration, and asks whether to generate documentation from code or import existing documentation. Generation asks the platform's documentation questions and uploads the filtered snapshot automatically after the questions. Local edits and untracked files are included unless excluded. Git ignore rules, platform exclusions, and mandatory credential/dependency exclusions apply. Symlinks are never included. Confirm the selected folder at the start; no second upload confirmation is required.

For existing documentation, select one or more suggested Markdown files/folders or enter paths inside the selected project, then name the Space (default: project folder name). The CLI uploads only selected `.md`/`.markdown` files and their referenced local PNG/JPEG/GIF/WebP images, preserving project-relative paths. This path skips generation questions and imports the existing content without AI generation. The backend must advertise support for documentation imports.

After the platform accepts the snapshot, the CLI prints the Space ID, opens and prints the direct Space progress URL, removes the local ZIP, and exits. For generation, the platform automatically prepares the repository and starts documentation under the account's existing access and credit rules. Existing documentation imports instead continue in the selected new Space and include a short optional paid Autopilot offer. There is no outline-review handoff. Generation, billing, progress, and notifications stay on the platform; the terminal does not poll for documentation progress.

```sh
node dist/index.js login
node dist/index.js logout
node dist/index.js --cwd ./packages/api --no-open
node dist/index.js --json
node dist/index.js --help
```

`--no-open` prints URLs without launching a browser. `--json` writes the final result to stdout as JSON; prompts go to stderr. Without an interactive terminal, generation/login returns `action_required` and exit code 2. It never guesses answers or uploads automatically. Cancellation exits with 130; other failures exit with 1.

Credentials and pending-upload state live outside your project in the operating system's user application-data directory, isolated by platform origin. Directories use mode 0700 and files use 0600 on systems that support Unix permissions. Protect your OS account and its application-data directory. No API key is required. Logout revokes the current CLI session.

Free and autotrial accounts can upload ZIPs up to 1 GB (1,073,741,824 bytes, inclusive). Paid personal and team accounts retain the 20 GB technical ceiling. This applies to the compressed ZIP, separately from extraction safety checks. Oversized uploads show an upgrade link without opening it automatically. The platform Markdown importer retains its separate 100 MB ceiling on every plan.

The server binds each multipart permission to its exact part size and rechecks entitlement on completion and snapshot claiming. There is no concurrent-upload quota: per-file limits and stale-upload cleanup do not fully prevent aggregate storage abuse from many abandoned uploads.

An interrupted transfer keeps its approved private snapshot for retry. Run the command again to resume it or discard it. A cancelled unfinished upload removes its local snapshot and attempts server cleanup. Once upload completion has been acknowledged, pending submission identity is retained on interruption to prevent a repeated import after an uncertain response.

## Local backend QA

Only the official production origin is accepted by default. Explicitly enable a loopback or `.test` backend for development:

```sh
DOCUWRITER_ALLOW_LOCAL=1 DOCUWRITER_API_URL=http://127.0.0.1:8000 node dist/index.js --no-open
```

This does not start a backend. Credentials are stored separately per origin. OAuth and continuation URLs must match that origin. Signed storage requests never receive the platform bearer token.

## Verification

```sh
npm run check
npm test
npm pack --dry-run
```

Publishing, deployment, and enabling the homepage command are separate release steps. Do not advertise the npm command until its package and backend are available.

The GitHub Actions workflow runs the same checks on macOS, Linux, and Windows with Node 22 and the latest Node release. It has not been run remotely. A real browser sign-in/signup and multipart upload against the deployed backend, plus manual interactive checks on all three operating systems, remain release checks. An npm registry lookup returning no public package does not establish publishing ownership; verify the intended publisher before release.

## CLI analytics

Only after successfully signing in, the CLI sends authenticated usage events to DocuWriter for PostHog analytics: steps, selections, durations, retries, errors, upload counts, and the submitted company/project name, sector, documentation goal, timezone, and documentation type after authentication. It does not send source contents, selected paths or filenames, credentials, signed upload URLs, or raw error messages. No anonymous events are collected, buffered, or sent. Help/version, pre-sign-in prompts, and unsuccessful sign-ins produce no analytics. A first-run notice explains this.

Use `docuwriter analytics off`, `docuwriter analytics on`, or `docuwriter analytics status` to control analytics. `DOCUWRITER_TELEMETRY_DISABLED=1` overrides the saved preference. Opt-out clears pending telemetry and suppresses optional correlated server events; operational import/submission records still support reliability.

Events use a random installation identity and a separate identity per run. Unsent events are buffered privately outside the project for at most seven days, capped at 500 events. Account answers are only delivered for the same authenticated account. Analytics outages never prevent uploads; network delivery has a two-second time budget per flush.

Authenticated failures include a bounded error code, failing step, HTTP status and retry count. When the platform returns a request ID, the CLI shows a support reference (also `request_id` in JSON output). Share that reference with support to locate the matching server log. Operational backend failures are logged even when product analytics is disabled; anonymous client events remain disabled. Raw errors, credentials, signed URLs and source contents are excluded from these diagnostics.
