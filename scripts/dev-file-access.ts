import type { Plugin } from 'vite';

// Neither renderer needs project text documents. Deny them before Vite's raw,
// import and /@fs handlers so a credential .txt can never become a module.
export const PRIVATE_DEV_FILES = [
  '.env', '.env.*', '**/*.{txt,md,jsonl,log,crt,pem,key,bin,sqlite,sqlite3,db,epub,zip,bak,v3backup}',
  '**/*.{sqlite,sqlite3,db}-*', '**/.git/**', '**/electron/**', '**/src/core/**',
  '**/docs/**', '**/backups/**', '**/tests/**', '**/release/**', '**/dist-electron/**',
  '**/artifacts/**', '**/data/**', '**/private-local/**', '**/tools/**', '**/samples/**',
];

export function privateDevPath(url: string): boolean {
  let path = url.split(/[?#]/, 1)[0] ?? '';
  try {
    // Reject residual encodings too; multiple decoding layers must not bypass
    // this middleware and later resolve to a private path in another handler.
    for (let i = 0; i < 4; i++) {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    }
  } catch { return true; }
  if (/%[0-9a-f]{2}/i.test(path) || /[\0]/.test(path)) return true;
  path = path.replace(/\\/g, '/');
  // NTFS stream syntax (file:stream or file::$DATA) is never a renderer asset.
  // The sole valid filesystem colon is Vite's leading /@fs/C:/ drive prefix.
  if (path.replace(/^\/@fs\/[a-z]:\//i, '/@fs/').includes(':')) return true;
  return /(?:^|\/)\.env(?:[./]|$)/i.test(path)
    || /\.(?:txt|md|jsonl|log|crt|pem|key|bin|sqlite3?|db|epub|zip|bak|v3backup)(?:[-./;]|$)/i.test(path)
    || /(?:^|\/)(?:\.git|electron|docs|backups|tests|release|dist-electron|artifacts|data|private-local|tools|samples)(?:\/|$)/i.test(path)
    || /(?:^|\/)src\/core(?:\/|$)/i.test(path);
}

export function privateDevFiles(): Plugin {
  return {
    name: 'private-development-files',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!privateDevPath(req.url ?? '')) return next();
        res.statusCode = 403;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end('This file is not available to the renderer.');
      });
    },
  };
}
