import assert from 'node:assert/strict';
import { sum } from './sum.mjs';
assert.equal(sum(2, 3), 5);
console.log('watcher live probe passed');
