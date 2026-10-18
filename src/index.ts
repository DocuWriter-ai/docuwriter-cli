#!/usr/bin/env node
import { Command } from 'commander';
import { run, type Options } from './flow.js';
const program = new Command().name('docuwriter').description('Upload a local project and continue documentation in DocuWriter.').version('0.1.0')
  .option('--cwd <directory>', 'Document precisely this directory')
  .option('--no-open', 'Print browser URLs without opening them')
  .option('--json', 'Write the final result as JSON; interactive confirmation remains required');
program.action(async options => run('start', options));
for (const command of ['login', 'logout'] as const) {
  program.command(command).description(command === 'login' ? 'Authorize this device in your browser' : 'Revoke the saved CLI session')
    .action(async (_options, child: Command) => run(command, child.optsWithGlobals() as Options));
}
program.command('analytics [setting]').description('Control CLI analytics: on, off, or status').action(async (setting, _options, child: Command) => run('analytics', { ...child.optsWithGlobals(), analytics: setting ?? 'status' } as Options));
await program.parseAsync();
