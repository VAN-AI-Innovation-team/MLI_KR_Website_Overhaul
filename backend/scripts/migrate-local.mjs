import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Use Node directly, avoiding PowerShell execution-policy and shell quoting issues.
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

for (const database of ['mli-content', 'mli-ops']) {
  const result = spawnSync(process.execPath, [cli, 'd1', 'migrations', 'apply', database, '--local'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
