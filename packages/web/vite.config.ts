import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

/**
 * vite-plugin-cesium defaults to the literal path `node_modules/cesium/Build`,
 * resolved against the process working directory. npm workspaces hoist cesium
 * to the *repo root* node_modules, so that path does not exist from
 * packages/web and the plugin silently fails to copy Cesium's Workers, Assets,
 * Widgets and ThirdParty — leaving a build with no Cesium runtime in it.
 *
 * Resolving the package for real fixes both the dev-server middleware and the
 * production copy, and keeps working regardless of whether the dependency ends
 * up hoisted or nested.
 */
const require = createRequire(import.meta.url);
const cesiumRoot = path.dirname(require.resolve('cesium/package.json'));
const cesiumBuildRootPath = path.join(cesiumRoot, 'Build');
const cesiumBuildPath = path.join(cesiumBuildRootPath, 'Cesium');

export default defineConfig({
  plugins: [react(), cesium({ cesiumBuildRootPath, cesiumBuildPath })],
  resolve: {
    alias: {
      // Point at the shared package's sources so `vite dev` and `vitest` pick
      // up edits immediately instead of requiring a build of @gme/shared first.
      '@gme/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Cesium itself is external in production (the plugin ships the
        // prebuilt Cesium.js and a global), so only three needs splitting out.
        manualChunks(id) {
          return id.includes('node_modules/three') ? 'three' : undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
