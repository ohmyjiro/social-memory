import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function scheduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function labelFor(dataDir) {
  const suffix = createHash('sha256').update(dataDir).digest('hex').slice(0, 12);
  return `com.social-memory.sync.${suffix}`;
}

export function scheduleReadiness(db) {
  const selected = db.prepare(`
    SELECT
      accounts.id AS account_id,
      accounts.connector_id,
      accounts.configured_identity,
      accounts.authenticated_identity,
      accounts.status,
      accounts.config_json,
      account_capture_kinds.kind,
      manual_sync_receipts.success_at,
      manual_sync_receipts.authenticated_identity AS receipt_identity
    FROM accounts
    JOIN account_capture_kinds ON account_capture_kinds.account_id = accounts.id
    LEFT JOIN manual_sync_receipts
      ON manual_sync_receipts.account_id = accounts.id
      AND manual_sync_receipts.kind = account_capture_kinds.kind
    ORDER BY accounts.id, account_capture_kinds.kind
  `).all().map((row) => ({ ...row }));
  const missing = selected.filter((row) =>
    row.status !== 'ready' ||
    !row.success_at ||
    !row.authenticated_identity ||
    row.receipt_identity !== row.authenticated_identity);
  const unschedulable = selected.filter((row) => {
    if (row.connector_id !== 'x') return false;
    const config = JSON.parse(row.config_json);
    return !config.keychainService;
  });
  return {
    ready: selected.length > 0 && missing.length === 0 && unschedulable.length === 0,
    selectedCount: selected.length,
    missing: missing.map(({ account_id: accountId, connector_id: connectorId, kind }) => ({
      accountId,
      connectorId,
      kind,
    })),
    unschedulable: unschedulable.map(({ account_id: accountId, connector_id: connectorId, kind }) => ({
      accountId,
      connectorId,
      kind,
      reason: 'keychain_credential_required',
    })),
  };
}

function renderPlist({ config, intervalMinutes, label, nodePath, cliPath, pathValue }) {
  const values = [
    nodePath,
    '--disable-warning=ExperimentalWarning',
    cliPath,
    'sync',
    '--scheduled',
    '--json',
  ].map((value) => `      <string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${values}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SOCIAL_MEMORY_DATA_DIR</key>
    <string>${xml(config.dataDir)}</string>
    <key>PATH</key>
    <string>${xml(pathValue)}</string>
  </dict>
  <key>StartInterval</key>
  <integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xml(join(config.logsDir, 'scheduler.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(config.logsDir, 'scheduler.err.log'))}</string>
</dict>
</plist>
`;
}

export function createLaunchAgentManager({
  homeDir = homedir(),
  uid = process.getuid?.(),
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)),
  pathValue = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
  execFileImpl = execFile,
} = {}) {
  if (!Number.isInteger(uid)) throw new Error('A numeric macOS user id is required');

  function paths(config) {
    const label = labelFor(config.dataDir);
    return {
      label,
      plistPath: join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`),
    };
  }

  return Object.freeze({
    async install({ db, config, intervalMinutes }) {
      const minutes = Number(intervalMinutes);
      if (!Number.isInteger(minutes) || minutes < 5 || minutes > 43_200) {
        throw scheduleError('invalid_interval', 'Schedule interval must be an integer from 5 to 43200 minutes');
      }
      const readiness = scheduleReadiness(db);
      if (!readiness.ready) {
        const reason = readiness.unschedulable.length > 0
          ? 'Scheduled X sync requires a macOS Keychain credential reference'
          : 'Every selected stream requires a successful manual sync before schedule installation';
        throw scheduleError('schedule_not_ready', reason);
      }

      const { label, plistPath } = paths(config);
      await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${plistPath}.${process.pid}.tmp`;
      await writeFile(
        temporaryPath,
        renderPlist({ config, intervalMinutes: minutes, label, nodePath, cliPath, pathValue }),
        { mode: 0o600 },
      );
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, plistPath);
      try {
        await execFileImpl('launchctl', ['bootout', `gui/${uid}/${label}`], { shell: false });
      } catch {
        // The agent may not be loaded yet.
      }
      await execFileImpl('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { shell: false });
      return { status: 'installed', label, plistPath, intervalMinutes: minutes };
    },
    async status({ config }) {
      const { label, plistPath } = paths(config);
      let installed = true;
      try {
        await access(plistPath);
      } catch {
        installed = false;
      }
      if (!installed) return { status: 'not_installed', label, plistPath };
      try {
        await execFileImpl('launchctl', ['print', `gui/${uid}/${label}`], { shell: false });
        return { status: 'loaded', label, plistPath };
      } catch {
        return { status: 'installed_not_loaded', label, plistPath };
      }
    },
    async uninstall({ config }) {
      const { label, plistPath } = paths(config);
      try {
        await execFileImpl('launchctl', ['bootout', `gui/${uid}/${label}`], { shell: false });
      } catch {
        try {
          await execFileImpl('launchctl', ['print', `gui/${uid}/${label}`], { shell: false });
          throw scheduleError(
            'schedule_unload_failed',
            'LaunchAgent is still loaded; its plist was preserved',
          );
        } catch (error) {
          if (error?.code === 'schedule_unload_failed') throw error;
          // The agent is not loaded, so removing a stale plist is safe.
        }
      }
      await unlink(plistPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
      return { status: 'uninstalled', label, plistPath };
    },
  });
}
