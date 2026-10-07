/**
 * Fails its own first evaluation, succeeds every one after: lets lazyLoad.test.mjs prove that
 * lazyImport()'s cache-busted retry is a genuinely new attempt, not the module loader's cached failure
 * record for the original specifier answering a second time. See flakyState.mjs for why this is split
 * across two files.
 */
import { nextCallFails } from './flakyState.mjs';

if (nextCallFails()) throw new Error('fixture: simulated first-attempt failure');

export const ok = true;
