import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  treeshake: true,
  outDir: 'dist',
  // dayjs is externalized (peer-like behavior); lodash-es is bundled so CJS
  // consumers don't get an ExperimentalWarning (or hard failure on Node <22)
  // from require()-ing ESM.
  external: [
    'dayjs',
    'dayjs/plugin/isSameOrAfter',
    'dayjs/plugin/isSameOrBefore',
    'dayjs/plugin/timezone',
    'dayjs/plugin/utc',
  ],
});
