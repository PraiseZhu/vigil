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

/**
 * 事件里的文字（原因、细节、issue 名、文件名……）可能来自模型或仓库内容，放进 mrkdwn 前必须转义：
 * 不转义的话 `<!channel>`、`<@U…>`、`<https://别处|打开 PR>` 都会被 Slack 当成真的 @ 或链接。
 * 只转 Slack 要求的三个字符（& < >）。
 */
export function esc(value) {
  return mute(String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

/**
 * 再把裸的 @ 拆开（@ 后面插一个零宽字符）：`@channel` / `@here` / `@everyone` / `@某人` 即使 Slack 开了
 * link_names 也不会被当成提醒。`<!here>` / `<!subteam^…>` / `<@U…>` 这类尖括号写法靠上面转义 `<>` 已经失效。
 */
const ZWSP = '\u200b';
function mute(value) {
  return String(value ?? '').replace(/@/g, `@${ZWSP}`);
}

/** 事件类型只认小写字母、数字和连字符，别的当没有（类型会进标题和通知栏文字）。 */
const TYPE_NAME = /^[a-z0-9-]{1,40}$/;
function safeType(value) {
  const type = str(value);
  return TYPE_NAME.test(type) ? type : '';
}

/** `owner/repo#n` 只有仓库名合规、编号是正整数才认，否则当没有（ref 会进标题和通知栏文字）。 */
function safeRef(value) {
  const ref = splitRef(value);
  return ref && REPO_NAME.test(ref.repo) && Number.isInteger(ref.number) && ref.number > 0 ? `${ref.repo}#${ref.number}` : '';
}

/** 仓库名只认 owner/repo（GitHub 允许的字符），别的一律当没有。 */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

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
  const candidate = str(event?.repo).includes('/') ? str(event.repo) : splitRef(event?.issue)?.repo || splitRef(event?.root)?.repo || '';
  const repo = REPO_NAME.test(candidate) ? candidate : '';
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
  if (match && REPO_NAME.test(`${match[1]}/${match[2]}`)) return { repo: `${match[1]}/${match[2]}`, pr: Number(match[3]), link: url };
  return { repo, pr, link: '' };
}

function head7(sha) {
  const value = str(sha).trim();
  return /^[0-9a-fA-F]{7,}$/.test(value) ? value.slice(0, 7) : '';
}

/** CI 链接只认 https://github.com/ 下面、不带 `| < >` 的地址（否则能在 `<url|文字>` 里改掉显示的文字）；别的不放链接。 */
function httpUrl(value) {
  const url = str(value).trim();
  return /^https:\/\/github\.com\/[^\s|<>]+$/.test(url) ? url : '';
}

function header(text) {
  // plain_text 不解析 mrkdwn，不能转义（否则会原样显示 &lt;），只拆 @。标题本来也只用校验过的字段拼。
  return { type: 'header', text: { type: 'plain_text', text: clip(mute(text), HEADER_LIMIT), emoji: true } };
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

/**
 * `text` 是手机锁屏 / 通知栏看到的那一行，Slack 也按 mrkdwn 解析。它只用校验过的字段拼（常量标题、合规的
 * `owner/repo#n`、合规的 PR 链接、数字），事件里的原因 / 文件名 / issue 标题一律不进；拼完整行再转义一次兜底，
 * 所以这里不会有任何 `<…>` 链接或提醒。@ 提醒（profile 里配的用户 id）在 slack-notify 里、这一步之后才加。
 */
function finish(payload, profile) {
  return {
    text: esc(redact(String(payload.text ?? ''), profile)),
    blocks: deepRedact(payload.blocks || [], profile),
  };
}

/** Ready 消息里的 `repo#pr`：repo/pr 都在就用它们，否则退回事件里的 ref。 */
function readyName(event, target) {
  if (target.repo && target.pr) return `${target.repo}#${target.pr}`;
  return safeRef(event.issue) || safeRef(event.root) || '修正 PR';
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
  const sc = Array.isArray(event.sc) ? event.sc.filter((item) => Number.isInteger(item) && item > 0).map((item) => `SC${item}`) : [];
  const checks = event.checks && typeof event.checks === 'object' ? event.checks : null;
  const total = checks ? Number(checks.total) : NaN;
  const diff = event.diff && typeof event.diff === 'object' ? event.diff : null;
  const files = diff ? Number(diff.files) || 0 : null;

  const blocks = [header(title)];
  const fields = fieldsBlock([
    ['任务 issue', esc(str(event.root))],
    ['修正子 issue', esc(str(event.issue))],
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
  if (str(event.readyAt)) lines.push(`转 Ready：${esc(str(event.readyAt))}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  const blocks = [header(title), section(lines.join('\n'))];
  // 通知栏文字只用标题、固定说明和合规的 PR 链接；readyAt 这类事件原文只进 blocks。
  return finish({ text: [title, lines[0], target.link ? `PR：${target.link}` : ''].filter(Boolean).join('｜'), blocks }, profile);
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
  // 写闸的格式是「branch.push 扫到疑似密钥，没推：a.js, b.txt」：取第一个全角冒号后面（文件名里可能有半角冒号）。
  const at = text.indexOf('：');
  return (at >= 0 ? text.slice(at + 1) : text).trim();
}

/**
 * 单条提醒（阻塞类 ping，或摘要里也用不到时单独发的那种）。
 * `secret-found` 只列文件名：reason 冒号前的话一个字都不带出去。
 */
export function alertBlocks(notice, profile) {
  const event = view(notice);
  const type = safeType(event.type) || safeType(event.kind) || 'alert';
  const issue = safeRef(event.issue);
  const base = ALERT_TITLES[type] || `验收机提醒：${type}`;
  const title = issue ? `${base}：${issue}` : base;
  const rawIssue = str(event.issue);

  const blocks = [header(title)];
  if (type === 'secret-found') {
    const files = secretFileList(event.reason);
    blocks.push(section(`文件名：${esc(files) || '（提醒里没给文件名）'}`));
    // 文件名可能是模型起的（比如就叫 `<!channel>`），只进转义过的 blocks，不进通知栏文字。
    const count = files ? files.split(',').filter((name) => name.trim()).length : 0;
    return finish({ text: `${title}｜${count} 个文件，文件名见消息`, blocks }, profile);
  }

  const lines = [];
  if (type === 'interrupted-repeat') {
    const count = Number(event.windowCount) || 0;
    const kinds = Array.isArray(event.windowKinds) && event.windowKinds.length ? esc(event.windowKinds.join('、')) : '中断类提醒';
    lines.push(`6 小时内同一任务连续中断 ${count} 次（${kinds}），后面这些不再逐条发。`);
  }
  if (str(event.reason)) lines.push(`原因：${esc(str(event.reason))}`);
  if (type === 'needs-human' && str(event.detail)) {
    lines.push(`细节：${esc(str(event.detail))}`);
  }
  const target = prLink(event);
  if (target.link) lines.push(`PR：${target.link}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  if (rawIssue && !issue) lines.push(`issue：${esc(rawIssue)}`);
  if (str(event.root) && str(event.root) !== rawIssue) lines.push(`任务 issue：${esc(str(event.root))}`);
  if (lines.length) blocks.push(section(lines.join('\n')));

  // 原因只进 blocks（转义过）；通知栏文字只有标题和合规的 PR 链接。
  return finish({ text: `${title}${target.link ? `｜${target.link}` : ''}`, blocks }, profile);
}

/**
 * 摘要：攒起来的多条合成一条。摘要**永远不 @**（这里根本没有 mention 参数）。
 */
export function digestBlocks(notices, profile) {
  const items = Array.isArray(notices) ? notices.filter(Boolean) : [];
  const lines = [];
  const heads = [];
  for (const item of items.slice(0, 40)) {
    const data = view(item);
    const type = safeType(data.type) || safeType(data.kind) || 'alert';
    const issue = str(data.issue);
    const reason = clip(str(data.reason), 140);
    const head = [type, issue].filter(Boolean).join(' ');
    lines.push(`· ${esc(head)}${reason ? `：${esc(reason)}` : ''}`);
    // 通知栏文字只用类型和合规的 ref。
    heads.push([type, safeRef(data.issue)].filter(Boolean).join(' '));
  }
  if (items.length > 40) lines.push(`…还有 ${items.length - 40} 条`);
  const title = `验收机摘要（${items.length} 条）`;
  const blocks = [header(title), section(lines.join('\n') || '（没有内容）')];
  const text = clip(`${title}：${heads.slice(0, 3).join('；')}`, 500);
  return finish({ text, blocks }, profile);
}
