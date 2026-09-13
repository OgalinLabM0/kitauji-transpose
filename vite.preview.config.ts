import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';
import { PRIVATE_DEV_FILES } from './scripts/dev-file-access';

// An independent loopback origin keeps browser drafts separate from Electron and
// normal renderer development. No proxy, database, Electron process or API client.
export default defineConfig(({ command, mode }) => {
  if (command !== 'serve' || mode !== 'browser-preview') throw new Error('Browser preview is development-only; use npm run dev:preview.');
  const csp = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:4176; object-src 'none'; base-uri 'none'; form-action 'none'";
  return mergeConfig(base, {
    // Pin these values independently of .env files. Only this development config
    // permits React Refresh's preamble and the local Vite HMR websocket.
    envDir: false,
    envPrefix: [],
    publicDir: false,
    define: { 'import.meta.env.VITE_BROWSER_PREVIEW': JSON.stringify('true') },
    server: {
      host: '127.0.0.1', port: 4176, strictPort: true, open: false,
      cors: false, proxy: {}, ws: { host: '127.0.0.1', port: 4176 },
      fs: { strict: true, deny: PRIVATE_DEV_FILES },
      headers: { 'Content-Security-Policy': csp },
    },
    plugins: [{
      name: 'isolated-browser-preview',
      configResolved(config) {
        if (config.server.host !== '127.0.0.1' || config.server.port !== 4176 || !config.server.strictPort) {
          throw new Error('Browser preview must bind only to 127.0.0.1:4176 with strictPort enabled.');
        }
      },
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string) => html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, `<meta http-equiv="Content-Security-Policy" content="${csp}" />`),
      },
    }],
  });
});
