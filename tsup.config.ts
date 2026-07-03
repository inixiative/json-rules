import { node } from '@inixiative/config/tsup';

export default node({
  entry: ['index.ts'],
  minify: true,
  treeshake: true,
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
