import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [subject, role = 'admin', ...extra] = process.argv.slice(2);
const roles = new Set(['admin', 'editor', 'moderator', 'consultant']);
if (!subject?.trim() || subject.length > 255 || /[\u0000-\u001f\u007f]/.test(subject)
  || !roles.has(role) || extra.length) {
  console.error('Usage: npm run admin:grant:local -- <verified-google-subject> [admin|editor|moderator|consultant]');
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const cli = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
const quotedSubject = subject.replaceAll("'", "''");
// A missing or inactive verified member produces NULL and fails the NOT NULL
// constraint. This command cannot create a user or grant to an email address.
const sql = `INSERT INTO admin_memberships (user_id, role, is_active, created_at, updated_at)
  VALUES ((SELECT i.user_id FROM auth_identities i JOIN users u ON u.id = i.user_id
    WHERE i.provider = 'google' AND i.subject = '${quotedSubject}' AND u.status = 'active'),
    '${role}', 1, unixepoch(), unixepoch())
  ON CONFLICT(user_id) DO UPDATE SET role = excluded.role, is_active = 1, updated_at = unixepoch()
  RETURNING user_id, role, is_active`;
const result = spawnSync(process.execPath, [cli, 'd1', 'execute', 'mli-ops', '--local', '--command', sql], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
