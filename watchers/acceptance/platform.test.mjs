// The acceptance host is Linux-only. Tests that need flock (loop, deploy-ff) or /proc (activity) skip themselves
// on a machine without them, such as the macOS developer machines; on CI they must run, so CI checks both are there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { FLOCK_SKIP, PROCFS_SKIP } from './fake-gh.fixture.mjs';

test('CI 上 flock 与 /proc 必须可用（Linux 专用用例不许被跳过）', { skip: process.env.CI ? false : '本地不是 CI' }, () => {
  assert.equal(FLOCK_SKIP, false, 'CI 上 flock 不可用：loop / deploy-ff 用例会被跳过');
  assert.equal(PROCFS_SKIP, false, 'CI 上 /proc 不可用：进程树 CPU 用例会被跳过');
});
