/* eslint-disable @typescript-eslint/no-require-imports */
const { openLocalD1, applyLocalMigrations } = require('./lib/local-d1.cjs');
async function main() {
  const [command, ...flags] = process.argv.slice(2);
  if (!['init', 'migrate', 'plan', 'inspect', 'reset-test'].includes(command)) throw new Error('LOCAL_D1_COMMAND_REQUIRED');
  const reset = command === 'reset-test';
  if (reset ? flags.length !== 1 || flags[0] !== '--test-only' : flags.length !== 0) throw new Error('LOCAL_D1_ARGUMENT_GUARD');
  // No user-supplied DB, config, path, --remote, environment, login or token arguments.
  const handle = await openLocalD1({ testOnly: reset });
  try {
    if (command === 'inspect') {
      console.log(JSON.stringify((await handle.db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name LIMIT 1000").all()).results, null, 2));
    } else {
      console.log(JSON.stringify(await applyLocalMigrations(handle, { dryRun: command === 'plan' }), null, 2));
    }
    console.log(`LOCAL_ONLY=YES; PRODUCTION_RESOURCE_CREATED=NO${reset ? '; TEST_RESET=FRESH_EPHEMERAL_DATABASE' : ''}`);
  } finally { await handle.dispose(); }
}
main().catch(() => { console.error('LOCAL_D1_COMMAND_FAILED'); process.exitCode = 1; });
