import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: chatfgm-attachment:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*",
  "frame-src 'self' blob: data: chatfgm-preview:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const PRODUCTION_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: chatfgm-attachment:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob: data: chatfgm-preview:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function contentSecurityPolicyPlugin(command: 'build' | 'serve'): Plugin {
  return {
    name: 'chatfgm-content-security-policy',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: {
            'http-equiv': 'Content-Security-Policy',
            content:
              command === 'serve' ? DEVELOPMENT_CSP : PRODUCTION_CSP,
          },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig(({ command }) => ({
  root: 'app',
  base: './',
  cacheDir: '../node_modules/.vite/app',
  plugins: [react(), contentSecurityPolicyPlugin(command)],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/test/results/**', '**/dist/**', '**/.*.tmpdir/**'],
    },
  },
  build: {
    outDir: '../dist/renderer',
    emptyOutDir: true,
  },
}));
