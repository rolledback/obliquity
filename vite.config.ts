import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: {
    // Minify the JS with esbuild (Vite's default) and the CSS too, so what ships is as small
    // as it can be before transport compression.
    minify: 'esbuild',
    cssMinify: true,
    // three.js core is ~600 kB minified on its own; that is expected for a 3D app, not a
    // smell, so lift the warning threshold above it rather than splitting it into noise.
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        // Split the heavy, rarely-changing libraries out of the app bundle so that shipping an
        // app-code change does not force returning visitors to re-download three.js + lil-gui;
        // their content-hashed chunks stay cached across deploys.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('node_modules')) return 'vendor';
          return undefined;
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
