#!/usr/bin/env node
// Slack 消息体（#61 SC2 / SC3）：纯函数，输入一条事件，输出 `{ text, blocks }`。
// `text` 是通知栏的回退文字（手机锁屏、通知中心看到的就这一行），`blocks` 是 Block Kit。
// 所有文字出去之前都过一遍 bin/redact.mjs：令牌、私钥、本机路径一律抹掉。
// 这里不读配置、不发请求、不碰令牌，只拼消息。
import { redact } from '../bin/redact.mjs';

/** 增删行数里的减号用排版减号（U+2212），和文档里的写法一致。 */
const MINUS = '\u2212';
const HEADER_LIMIT = 150;
const SECTION_LIMIT = 2900;

/** 只有这个形状的 PR 链接才认；<repo>/<pr> 对不上事件字段就自己拼。 */
const PR_URL = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;
const REF = /^([^\s#/]+\/[^\s#/]+)#(\d+)$/;

function str(value) {
  return typeof value === 'string' ? value : '';
}

function clip(text, limit) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** `owner/repo#n` 拆成仓库和编号；拆不出就返回 null。 */
function splitRef(value) {
  const match = REF.exec(str(value).trim());
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

/** 事件的完整视图：`notice.event` 打底，`notice` 自己的字段（id / kind / type …）覆盖上去。 */
function view(notice) {
  const base = notice && typeof notice.event === 'object' && notice.event ? { ...notice.event } : {};
  for (const [key, value] of Object.entries(notice || {})) {
    if (key === 'event' || value === undefined) continue;
    base[key] = value;
  }
  return base;
}

/**
 * PR 链接：只接受 `https://github.com/<repo>/pull/<pr>`，且 repo/pr 和事件字段一致。
 * 不一致（伪造的、指向别的仓的）或形状不对，就按事件里的 repo+pr 自己拼。
 */
export function prLink(event) {
  const repo = str(event?.repo).includes('/') ? str(event.repo) : splitRef(event?.issue)?.repo || splitRef(event?.root)?.repo || '';
  const prNumber = Number(event?.pr);
  const pr = Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null;
  const url = str(event?.prUrl).trim();
  const match = PR_URL.exec(url);
  if (repo && pr) {
    const built = `https://github.com/${repo}/pull/${pr}`;
    if (!match) return { repo, pr, link: built };
    const sameRepo = `${match[1]}/${match[2]}` === repo;
    const samePr = Number(match[3]) === pr;
    return { repo, pr, link: sameRepo && samePr ? url : built };
  }
  if (match) return { repo: `${match[1]}/${match[2]}`, pr: Number(match[3]), link: url };
  return { repo, pr, link: '' };
}

function head7(sha) {
  const value = str(sha).trim();
  return /^[0-9a-fA-F]{7,}$/.test(value) ? value.slice(0, 7) : '';
}

/** 只有 http(s) 的链接才放进 mrkdwn；别的一律当普通文字。 */
function httpUrl(value) {
  const url = str(value).trim();
  return /^https?:\/\/\S+$/.test(url) ? url : '';
}

function header(text) {
  return { type: 'header', text: { type: 'plain_text', text: clip(text, HEADER_LIMIT), emoji: true } };
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: clip(text, SECTION_LIMIT) } };
}

function fieldsBlock(fields) {
  const items = fields.filter(Boolean).map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}*\n${value}` }));
  return items.length ? { type: 'fields', fields: items } : null;
}

/** 深度脱敏：blocks 里每个字符串都过一遍 redact。 */
function deepRedact(value, profile) {
  if (typeof value === 'string') return redact(value, profile);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, profile));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepRedact(item, profile);
    return out;
  }
  return value;
}

function finish(payload, profile) {
  return {
    text: redact(String(payload.text ?? ''), profile),
    blocks: deepRedact(payload.blocks || [], profile),
  };
}

/** Ready 消息里的 `repo#pr`：repo/pr 都在就用它们，否则退回事件里的 ref。 */
function readyName(event, target) {
  if (target.repo && target.pr) return `${target.repo}#${target.pr}`;
  return str(event.issue) || str(event.root) || '修正 PR';
}

/**
 * SC2：修正 PR 已 Ready。
 * - `handoff: "owner"`：只有一个「打开 PR」按钮，链接是 PR 地址，没有第二个按钮。
 * - `handoff: "watcher"`：正文写「已交给 Mac mini 盯梢」，不带按钮，PR 链接作为文字给出。
 */
export function readyBlocks(notice, profile) {
  const event = view(notice);
  const target = prLink(event);
  const title = `修正 PR 已 Ready：${readyName(event, target)}`;
  const sc = Array.isArray(event.sc) ? event.sc.map((item) => `SC${item}`) : [];
  const checks = event.checks && typeof event.checks === 'object' ? event.checks : null;
  const total = checks ? Number(checks.total) : NaN;
  const diff = event.diff && typeof event.diff === 'object' ? event.diff : null;
  const files = diff ? Number(diff.files) || 0 : null;

  const blocks = [header(title)];
  const fields = fieldsBlock([
    ['任务 issue', str(event.root)],
    ['修正子 issue', str(event.issue)],
    ['head', head7(event.headSha)],
    [
      'CI',
      Number.isFinite(total)
        ? httpUrl(checks.url)
          ? `<${httpUrl(checks.url)}|CI ${Number(checks.green) || 0}/${total} 绿>`
          : `CI ${Number(checks.green) || 0}/${total} 绿`
        : '',
    ],
    [
      '改动',
      files === null
        ? ''
        : `${files} 个文件 +${Number(diff.additions) || 0} ${MINUS}${Number(diff.deletions) || 0}`,
    ],
    ['修了', sc.join('、')],
  ].map(([label, value]) => (value ? [label, value] : null)));
  if (fields) blocks.push(fields);

  const watcher = event.handoff === 'watcher';
  if (watcher) {
    blocks.push(section(target.link ? `已交给 Mac mini 盯梢\nPR：${target.link}` : '已交给 Mac mini 盯梢'));
  } else if (target.link) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '打开 PR', emoji: true },
          url: target.link,
        },
      ],
    });
  }

  const text = watcher
    ? `${title}｜已交给 Mac mini 盯梢${target.link ? `｜${target.link}` : ''}`
    : `${title}｜打开 PR${target.link ? `：${target.link}` : '（链接缺失）'}`;
  return finish({ text, blocks }, profile);
}

/** SC3：`ready-stalled`，转 Ready 满 24 小时没人接。 */
export function stalledBlocks(notice, profile) {
  const event = view(notice);
  const target = prLink(event);
  const title = `修正 PR 转 Ready 24 小时没人接：${readyName(event, target)}`;
  const lines = [
    '多半是审查流程不在线（review-ingress-missing），请看 Mac mini 和审查入口。',
  ];
  if (target.link) lines.push(`PR：${target.link}`);
  if (str(event.readyAt)) lines.push(`转 Ready：${str(event.readyAt)}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  const blocks = [header(title), section(lines.join('\n'))];
  return finish({ text: [title, ...lines].join('｜'), blocks }, profile);
}

const ALERT_TITLES = {
  'needs-human': '修正轮需要人工处理',
  'interrupted-exhausted': '修正轮中断：重试用完',
  'interrupted-repeat': '同一任务连续中断',
  'secret-found': '扫到疑似密钥，没有推送',
  'sandbox-unavailable': '沙箱起不来',
  'gate-unavailable': '写闸连不上',
  'gate-rejected': '写闸拒绝了写动作',
  'write-rejected': '写操作被拒',
  'round-stalled': '轮次卡住',
  'round-stale': '轮次卡死',
  'round-failed': '轮次出错',
  'loop-restarted': '调度循环被重新拉起',
  'tick-failed': '这一拍出错',
  'prbot-tick-failed': '修正轮这一拍出错',
};

/** `secret-found` 的 reason 形如「…没推：a.js, b.txt」：只取冒号后面的文件名列表。 */
function secretFileList(reason) {
  const text = str(reason).trim();
  const at = Math.max(text.lastIndexOf('：'), text.lastIndexOf(':'));
  return (at >= 0 ? text.slice(at + 1) : text).trim();
}

/**
 * 单条提醒（阻塞类 ping，或摘要里也用不到时单独发的那种）。
 * `secret-found` 只列文件名：reason 冒号前的话一个字都不带出去。
 */
export function alertBlocks(notice, profile) {
  const event = view(notice);
  const type = str(event.type) || str(event.kind) || 'alert';
  const issue = str(event.issue);
  const base = ALERT_TITLES[type] || `验收机提醒：${type}`;
  const title = issue ? `${base}：${issue}` : base;

  const blocks = [header(title)];
  if (type === 'secret-found') {
    const files = secretFileList(event.reason);
    blocks.push(section(`文件名：${files || '（提醒里没给文件名）'}`));
    return finish({ text: `${title}｜文件名：${files}`, blocks }, profile);
  }

  const lines = [];
  if (type === 'interrupted-repeat') {
    const count = Number(event.windowCount) || 0;
    const kinds = Array.isArray(event.windowKinds) && event.windowKinds.length ? event.windowKinds.join('、') : '中断类提醒';
    lines.push(`6 小时内同一任务连续中断 ${count} 次（${kinds}），后面这些不再逐条发。`);
  }
  if (str(event.reason)) lines.push(`原因：${str(event.reason)}`);
  if (type === 'needs-human' && str(event.detail)) {
    lines.push(`细节：${str(event.detail)}`);
  }
  const target = prLink(event);
  if (target.link) lines.push(`PR：${target.link}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  if (str(event.root) && str(event.root) !== issue) lines.push(`任务 issue：${str(event.root)}`);
  if (lines.length) blocks.push(section(lines.join('\n')));

  return finish({ text: `${title}${str(event.reason) ? `｜${str(event.reason)}` : ''}`, blocks }, profile);
}

/**
 * 摘要：攒起来的多条合成一条。摘要**永远不 @**（这里根本没有 mention 参数）。
 */
export function digestBlocks(notices, profile) {
  const items = Array.isArray(notices) ? notices.filter(Boolean) : [];
  const lines = [];
  for (const item of items.slice(0, 40)) {
    const data = view(item);
    const type = str(data.type) || 'alert';
    const issue = str(data.issue);
    const reason = clip(str(data.reason), 140);
    const head = [type, issue].filter(Boolean).join(' ');
    lines.push(`· ${head}${reason ? `：${reason}` : ''}`);
  }
  if (items.length > 40) lines.push(`…还有 ${items.length - 40} 条`);
  const title = `验收机摘要（${items.length} 条）`;
  const blocks = [header(title), section(lines.join('\n') || '（没有内容）')];
  const text = clip(`${title}：${lines.slice(0, 3).join('；')}`, 500);
  return finish({ text, blocks }, profile);
}
