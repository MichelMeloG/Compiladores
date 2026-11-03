import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    // Caminho em que os assets serão servidos.
    // O GitHub Pages de projeto publica em /<nome-do-repo>/, por isso o
    // workflow de publicação define BASE_PATH=/Compiladores/.
    // Use o prefixo do repositório também no servidor local para que os
    // endereços /Compiladores/dashboard e /Compiladores/compilador coincidam
    // com os caminhos publicados no GitHub Pages.
    base: process.env.BASE_PATH || '/Compiladores/',
    plugins: [
      {
        name: 'roboflow-local-route-aliases',
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url) {
              const [pathname, query] = request.url.split('?');
              const prefix = '/compiladores/';
              if (/^\/compiladores\/(dashboard|compilador)$/i.test(pathname)) {
                response.statusCode = 302;
                response.setHeader('Location', pathname + '/' + (query ? `?${query}` : ''));
                response.end();
                return;
              }
              if (pathname.toLowerCase().startsWith(prefix)) {
                let canonical = '/Compiladores/' + pathname.slice(prefix.length);
                if (/^\/Compiladores\/(dashboard|compilador)\/?$/i.test(canonical)) {
                  canonical = canonical.replace(/\/$/, '') + '/index.html';
                }
                request.url = canonical + (query ? `?${query}` : '');
              }
            }
            next();
          });
        },
      },
      react(),
      tailwindcss(),
    ],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      proxy: { '/api': { target: process.env.BACKEND_PROXY_URL || 'http://127.0.0.1:8080', changeOrigin: true } },
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
