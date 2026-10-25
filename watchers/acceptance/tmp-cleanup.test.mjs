// #70 复审：测试的临时目录跑完要删干净（以前每次全量测试在 /tmp 留七百多个目录，把 inode 用满）。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpBase } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('tmpDir 夹具建的目录在进程退出时删掉，权限被改成 000 / 只读的也删得掉', () => {
  const parent = fs.mkdtempSync(path.join(tmpBase(), 'acc-clean-'));
  try {
    const fixture = pathToFileURL(path.join(HERE, 'fake-gh.fixture.mjs')).href;
    const script = `
      import fs from 'node:fs';
      import path from 'node:path';
      const { tmpDir } = await import(${JSON.stringify(fixture)});
      const a = tmpDir();
      const b = tmpDir('acceptance-locked-');
      fs.mkdirSync(path.join(b, 'locked'));
      fs.writeFileSync(path.join(b, 'locked', 'f'), 'x');
      fs.chmodSync(path.join(b, 'locked'), 0o000);
      fs.chmodSync(b, 0o500);
      process.stdout.write(JSON.stringify([a, b]));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TMPDIR: parent },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const dirs = JSON.parse(result.stdout);
    assert.equal(dirs.length, 2);
    for (const dir of dirs) {
      assert.ok(dir.startsWith(parent + path.sep), dir);
      assert.equal(fs.existsSync(dir), false, `${dir} 退出后还在`);
    }
    assert.deepEqual(fs.readdirSync(parent), []);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
