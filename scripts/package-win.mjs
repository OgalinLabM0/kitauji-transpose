import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const temp = resolve(root, 'artifacts/temp/nsis-build');
const cache = resolve(root, 'artifacts/build-cache/electron-builder');
mkdirSync(temp, { recursive: true });
mkdirSync(cache, { recursive: true });

const env = { ...process.env, TEMP: temp, TMP: temp, ELECTRON_BUILDER_CACHE: cache };

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--publish' || args[i] === '-p') {
    if (args[i + 1] !== 'never') process.exitCode = 2, console.error('package:win only permits --publish never'), process.exit();
    i += 1;
  } else if (args[i].startsWith('--publish=') && args[i] !== '--publish=never') {
    process.exitCode = 2; console.error('package:win only permits --publish never'); process.exit();
  }
}
if (!args.some((arg) => arg === '--publish' || arg.startsWith('--publish='))) args.push('--publish', 'never');
if (!args.some((arg) => arg === '--config.electronDist' || arg.startsWith('--config.electronDist='))) {
  args.push('--config.electronDist=node_modules/electron/dist');
}
const builderCli = process.env.PACKAGE_WIN_ELECTRON_BUILDER_CLI ?? resolve(root, 'node_modules/electron-builder/cli.js');
const pack = spawnSync(process.execPath, [builderCli, '--win', 'nsis', ...args], { cwd: root, env, stdio: 'inherit' });
if (pack.error) throw pack.error;
process.exit(pack.status ?? 1);
