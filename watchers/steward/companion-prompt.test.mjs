import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ORDER_TYPES } from './bin/outbox.mjs';

const prompt = fs.readFileSync(new URL('./companion/PROMPT.md', import.meta.url), 'utf8');
const sections = new Map([...prompt.matchAll(/^## (.+)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)]
  .map(([, title, body]) => [title, body]));
const restrictions = [
  '不自己改代码', '不推送', '不合并', '不把 PR 转正式或转回草稿',
  '不 Approve', '不删除任何定时任务', '不动老盯梢的定时任务和状态目录',
  '不在回执里写没有核实过的结果',
];

test('SC5: every wire order has a section, a Cindy tool and an ack example', () => {
  assert.equal(ORDER_TYPES.length, 10);
  for (const type of ORDER_TYPES) {
    const body = sections.get(type);
    assert.ok(body, `missing section: ${type}`);
    assert.match(body, /list_machines|send_to_session|send_message_to_user/);
    assert.match(body, /node watchers\/steward\/bin\/steward-ack\.mjs --order <ID> --result \w+/);
  }
});

test('SC5: all eight restrictions are separate bullets', () => {
  const body = sections.get('禁止项');
  for (const text of restrictions) assert.ok(body.includes(`- ${text}。\n`), text);
});

test('companion instructions cover lookup, delivery, handoff and owner query', () => {
  assert.match(sections.get('找原会话'), /1\. 查总管登记[\s\S]*2\. .*schedule_list[\s\S]*3\. .*批准执行派发[\s\S]*4\. .*标题[\s\S]*有多个候选或一个都没有/);
  assert.match(sections.get('启动消息'), /GitHub 插件.*\/pr.*<PR 链接>.*合并或关闭/);
  assert.match(sections.get('新建专属会话'), /常驻机[\s\S]*project_path[\s\S]*托管工作树[\s\S]*#<PR号>-<任务名>丨<MMDD>[\s\S]*任务 issue[\s\S]*问题清单[\s\S]*作者交接文档路径[\s\S]*定时任务是活动的/);
  assert.match(sections.get('takeover'), /list_machines[\s\S]*仍离线[\s\S]*已上线回 `online`/);
  assert.match(sections.get('swap'), /200 字以内[\s\S]*确认原跟进定时任务已停止[\s\S]*再走专属新建流程[\s\S]*首条消息带摘要/);
  assert.match(sections.get('pause_original'), /只在原电脑用 `schedule_pause` 暂停这一条，不删除[\s\S]*send_to_session/);
  for (const type of ['stop_and_notify', 'notify_human']) {
    assert.match(sections.get(type), /`cindy_feishu_bot` 的 `send_message_to_user`[\s\S]*飞书[\s\S]*发一条通知/);
  }
  assert.match(sections.get('归属查询'), /steward-owner\.mjs --pr/);
});

test('SC9: Feishu notices name the companion own Feishu tool, never send_text', () => {
  assert.equal(prompt.includes('send_text'), false);
  assert.equal([...prompt.matchAll(/`cindy_feishu_bot` 的 `send_message_to_user`/g)].length, 2);
});
