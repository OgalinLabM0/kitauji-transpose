import { build } from 'esbuild';
import { rmSync, mkdirSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });
mkdirSync('dist-electron', { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  sourcemap: true,
  external: ['electron'],
  tsconfig: 'tsconfig.electron.json',
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
};

await build({ ...common, entryPoints: ['electron/main.ts'], format: 'esm', outfile: 'dist-electron/main.mjs' });
// 沙箱化预加载脚本必须是 CJS
await build({ ...common, entryPoints: ['electron/preload.ts'], format: 'cjs', outfile: 'dist-electron/preload.cjs' });
