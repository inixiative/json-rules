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
  external: [
    'dayjs',
    'dayjs/plugin/isSameOrAfter',
    'dayjs/plugin/isSameOrBefore',
    'dayjs/plugin/timezone',
    'dayjs/plugin/utc',
    'lodash',
    'pg',
  ],
});
