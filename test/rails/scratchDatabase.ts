import { PGlite } from '@electric-sql/pglite';
import { closeAtEndOfRun } from './atEndOfRun';

// why: a PGlite holds ~300 MB for as long as a variable points at it, closed or not, and takes
// ~0.6 s to start, so the test process has one for tables a test file makes itself.
let scratch: PGlite | undefined;

const startScratchDatabase = (): PGlite => {
  const db = new PGlite();
  closeAtEndOfRun(() => db.close());
  return db;
};

/** The test process's one scratch database, emptied and back on default session settings. */
export const scratchDatabase = async (): Promise<PGlite> => {
  scratch ??= startScratchDatabase();
  await scratch.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await scratch.exec('DISCARD ALL');
  return scratch;
};
