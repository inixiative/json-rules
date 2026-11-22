import { afterAll } from 'bun:test';
import { closeEverything } from './rails/atEndOfRun';

// why: a PGlite still open when the process ends turns a passing run's exit code into 99.
afterAll(closeEverything);
