import { node } from '@inixiative/config/tsup';

export default node({
  entry: ['index.ts'],
  minify: true,
  treeshake: true,
  // Date libraries and field-map are externalized; lodash-es is bundled so CJS
  // consumers don't get an ExperimentalWarning (or hard failure on Node <22)
  // from require()-ing ESM.
  external: [
    // One copy across the building blocks, so its branded types and readers are the same ones.
    '@inixiative/field-map',
    '@date-fns/tz',
    'date-fns',
  ],
});
