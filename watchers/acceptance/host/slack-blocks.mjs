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
/** 一条「写闸账本审计」提醒最多带几条明细（其余见审计日志）；和 host/gate-audit.mjs 的 AUDIT_DETAIL_LIMIT 一致。 */
const AUDIT_DETAIL_LIMIT = 5;

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

/**
 * CI 链接：事件给的 checks.url 只是 PR 页（prbot 给的就是 PR 地址）时改成它的 /checks 页；
 * 没给就按 PR 链接拼 /checks；都没有就不放链接。
 */
export function ciLink(checksUrl, target) {
  const url = httpUrl(checksUrl);
  if (url && PR_URL.test(url)) return `${url}/checks`;
  if (url) return url;
  return target?.link ? `${target.link}/checks` : '';
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
  // Slack 没有 `fields` 这种块：字段必须放在 section 的 fields 里（最多 10 个），否则整条消息被 invalid_blocks 拒掉。
  return items.length ? { type: 'section', fields: items.slice(0, 10) } : null;
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
  const ci = checks ? ciLink(checks.url, target) : '';

  const blocks = [header(title)];
  const fields = fieldsBlock([
    ['任务 issue', esc(str(event.root))],
    ['修正子 issue', esc(str(event.issue))],
    ['head', head7(event.headSha)],
    [
      'CI',
      Number.isFinite(total)
        ? ci
          ? `<${ci}|CI ${Number(checks.green) || 0}/${total} 绿>`
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
    '多半是审查流程不在线，请看 Mac mini 和审查入口。',
    '有没有影响：这个修正 PR 一直没人审，不会自动合并。',
    '验收机已自动做了什么：PR 原样留着，没有再动。',
    '要不要人处理：需要：看一眼 Mac mini 上的审查流程是否在线。',
  ];
  if (target.link) lines.push(`PR：${target.link}`);
  if (str(event.readyAt)) lines.push(`转 Ready：${esc(str(event.readyAt))}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  const blocks = [header(title), section(lines.join('\n'))];
  // 通知栏文字只用标题、固定说明和合规的 PR 链接；readyAt 这类事件原文只进 blocks。
  return finish({ text: [title, lines[0], target.link ? `PR：${target.link}` : ''].filter(Boolean).join('｜'), blocks }, profile);
}

/** 写闸原因翻成人话。未知原因只给「写闸给的原因：<代码>」，不把事件原文整段塞进标题。 */
export const GATE_REASON_TEXT = Object.freeze({
  'needs-round-binding': '这个写操作只允许在验收轮里做，当时不在轮次里',
  'not-in-tree': '目标不在这个任务的 issue 树里',
  'bad-action': '动作格式不对',
  'gate-error': '写闸内部出错',
  'query-not-allowed': '查询不在允许范围内',
  'repo-not-allowed': '仓库不在允许名单里',
  'edit-not-allowed': '这种修改不被允许',
});

function gateReasonText(reason) {
  const code = str(reason);
  if (GATE_REASON_TEXT[code]) return GATE_REASON_TEXT[code];
  const safe = TYPE_NAME.test(code) ? code : 'unknown';
  return `写闸给的原因：${safe}`;
}

/** 每种提醒的人话文案。title / what / impact / auto / action 都是固定句子；动态句在 noticeCopy 里补。 */
export const NOTICE_COPY = Object.freeze({
  'needs-human': {
    title: '修正轮卡住了，需要你处理',
    what: '自动修正这件事走不下去了（比如修正次数用完或有冲突），验收机不会再自己往下推。',
    impact: '只有这一个修正任务停在原地，其它任务照常。',
    auto: '已停止这件事的自动修正，PR 和分支原样留着。',
    action: '需要：打开下面的 issue / PR 看原因，决定手动修还是关掉。',
    needsHuman: true,
  },
  'interrupted-exhausted': {
    title: '修正轮反复中断，重试次数用完',
    what: '修正轮连续中断，自动重试的次数已经用完。',
    impact: '只有这一个修正任务停了，其它任务照常。',
    auto: '已停止自动重试，现场原样留着。',
    action: '需要：看一眼中断原因（常见是模型网关或沙箱问题），决定要不要人工接手。',
    needsHuman: true,
  },
  'interrupted-repeat': {
    title: '同一任务 6 小时内反复中断',
    what: '',
    impact: '这个任务一直没验完，其它任务照常。',
    auto: '每次都已自动中止并稍后重开；后面同类中断不再逐条发。',
    action: '需要：多半是环境问题（沙箱、模型网关、写闸），请让修复员查一下。',
    needsHuman: true,
  },
  'secret-found': {
    title: '推送前扫到疑似密钥，已拦下没推',
    what: '验收机准备推送代码时，在下面这些文件里扫到像密钥的内容。',
    impact: '代码没有推出去，密钥没有外泄；这一步修正没推成。',
    auto: '已拦下这次推送，内容没有离开本机。',
    action: '需要：确认这些文件里是不是真密钥，是的话删掉或换掉。',
    needsHuman: true,
  },
  'gate-audit-violation': {
    title: '写闸账本审计发现越规写入',
    what: '旁路审计逐条核对写闸账本，发现有已执行的写入不符合写闸规则（明细见下）。',
    impact: '这些写入已经发生在 GitHub 上（审计是事后核对，拦不住）；验收机其它部分照常运行。',
    auto: '只把明细记进了审计日志并发了这条提醒；没有关写闸，也没有改动、撤回任何东西。',
    action: '需要：请让修复员按明细逐条核对，确认是不是写闸放行出了问题；核对完运行 gate-audit.mjs --ack 清零。',
    needsHuman: true,
  },
  'sandbox-unavailable': {
    title: '沙箱起不来，这一轮没跑成',
    what: '验收机要起隔离沙箱跑这一轮，沙箱没起来。',
    impact: '这个任务这一轮没验，暂时不会出结论；其它任务照常。',
    auto: '已中止这一轮（GitHub 上标「中断」），稍后自动重试。',
    action: '先不用：偶发会自己恢复；同一任务连着出会再提醒，那时请让修复员查。',
    needsHuman: false,
  },
  'sandbox-down': {
    title: '沙箱自检没过，这一拍没接新任务',
    what: '开轮前的沙箱自检没过。',
    impact: '这一次没认领任务，也没写任何东西；已经在跑的不受影响。',
    auto: '已跳过认领，下一拍（约 1 分钟后）自动再试。',
    action: '先不用；一直不恢复请让修复员查。',
    needsHuman: false,
  },
  'gate-unavailable': {
    title: '写闸没起来，这一轮已中止',
    what: '验收机每次写 GitHub 都要经过写闸（安全关卡），这次写闸没起来。',
    impact: '这一轮没法写结论，但也没有任何越权写入。',
    auto: '已中止这一轮，稍后自动重开。',
    action: '先不用；同一任务连着出会再提醒。',
    needsHuman: false,
  },
  'gate-rejected': {
    title: '写闸拦下了一个不合规的写操作',
    what: '这一轮想做的一个写动作不符合写闸规则，被拦下了。',
    impact: '被拦的那一下没有执行，GitHub 上什么都没改；这一轮可能少写一条记录。',
    auto: '已拦下并记日志，轮次本身照常继续。',
    action: '一般不用；同一任务反复出现请让修复员看看是规则太紧还是模型走偏。',
    needsHuman: false,
  },
  'write-rejected': {
    title: '认领被写闸拒绝，这一轮没开',
    what: '验收机要在 issue 上留认领评论、开始验收，被写闸拒了。',
    impact: '这个任务这次没开始验收。',
    auto: '已放弃这次认领，下一拍重新判断。',
    action: '先不用；同一任务反复出现请让修复员查写闸配置。',
    needsHuman: false,
  },
  'round-stalled': {
    title: '轮次卡住没进度，已自动中止',
    what: '这一轮超过设定时间没有任何进度。',
    impact: '这个任务这一轮没验完，其它任务照常。',
    auto: '已中止这一轮（GitHub 上标「中断」），稍后自动重开。',
    action: '先不用；反复卡住会再提醒。',
    needsHuman: false,
  },
  'round-stale': {
    title: '轮次进程没了，已自动收尾',
    what: '登记为在跑的轮次，进程已经不在了（多半被系统杀掉或机器重启过）。',
    impact: '这个任务这一轮没验完，其它任务照常。',
    auto: '已把这一轮标成「中断」，稍后自动重开。',
    action: '先不用；反复出现请让修复员查。',
    needsHuman: false,
  },
  'round-failed': {
    title: '验收轮次出错，已自动中止',
    what: '这一轮跑的过程中出错了（模型没写出结论，或宿主报错）。',
    impact: '这个任务这一轮没出结论，其它任务照常。',
    auto: '已中止这一轮（GitHub 上标「中断」），稍后自动重开。',
    action: '先不用；同一任务 6 小时内再出会提醒，那时请让修复员查。',
    needsHuman: false,
  },
  'round-timeout': {
    title: '轮次超过总时长上限，已自动中止',
    what: '这一轮跑的时间超过了设定的总时长上限。',
    impact: '这个任务这一轮没出结论，其它任务照常。',
    auto: '已中止这一轮（GitHub 上标「中断」），稍后自动重开。',
    action: '先不用；反复超时请让修复员看看是不是任务太大。',
    needsHuman: false,
  },
  'prefetch-failed': {
    title: '拉代码失败，这一轮已中止',
    what: '开轮前要先把相关仓库的代码拉到本机，这次没拉下来（多半是网络或权限）。',
    impact: '这个任务这一轮没跑，其它任务照常。',
    auto: '已中止这一轮，稍后自动重开。',
    action: '先不用；反复出现请检查 GitHub 访问。',
    needsHuman: false,
  },
  'deps-failed': {
    title: '依赖装不上，这一轮已中止（环境问题，不是代码不通过）',
    what: '开轮前验收机要在沙箱外按 lockfile 预装 npm 依赖，这次没装成（常见是 npm 官方源连不上、lockfile 里有官方源以外的地址，或超时）。',
    impact: '这个任务这一轮没验、没出任何结论，不会被判不通过；其它任务照常。',
    auto: '已中止这一轮（GitHub 上标「中断」并写明是环境问题），按退避稍后自动重试，同一任务连续失败时间隔拉长到 30 分钟、2 小时、6 小时。',
    action: '先不用；同一任务反复出现请让修复员查 npm 源或这个仓的 lockfile。',
    needsHuman: false,
  },
  'loop-restarted': {
    title: '验收机调度循环被重新拉起',
    what: '保活脚本发现调度循环不正常。',
    impact: '停摆这段时间没有派发新任务；已经在跑的轮次不受影响。',
    auto: '保活脚本已把调度循环重新拉起。',
    action: '不用；一天内反复出现请让修复员查。',
    needsHuman: false,
  },
  'tick-failed': {
    title: '验收机有一拍调度出错',
    what: '一次调度（每分钟一次）中途出错，常见是网络瞬断。',
    impact: '只影响这一分钟，下一拍会自动再来。',
    auto: '已记日志，下一拍自动重试。',
    action: '不用。',
    needsHuman: false,
  },
  'prbot-tick-failed': {
    title: '修正轮有一拍出错',
    what: '修正轮的一次调度中途出错，常见是网络瞬断。',
    impact: '只影响这一分钟的修正调度，下一拍会自动再来。',
    auto: '已记日志，下一拍自动重试。',
    action: '不用。',
    needsHuman: false,
  },
  'tick-failed-repeat': {
    title: '验收机调度连续出错',
    what: '',
    impact: '这段时间新任务派发、收尾可能都停着。',
    auto: '每一拍都在自动重试，调度循环本身还在跑。',
    action: '需要：请让修复员查（多半是网络或 GitHub 访问出了问题）。',
    needsHuman: true,
  },
  'adjudicate-needs-human': {
    title: '有争议的条目裁决不出来，需要你裁决',
    what: '验收里有条目判不清（有争议），自动裁决重试用完仍没结果。',
    impact: '这个任务卡在等裁决，不会自动关单。',
    auto: '已停止自动裁决重试。',
    action: '需要：到 issue 里看争议条目，人工给结论。',
    needsHuman: true,
  },
  'adjudicate-failed': {
    title: '裁决运行失败一次，会自动重试',
    what: '给争议条目做裁决的那次运行失败了。',
    impact: '这个任务等裁决的时间会变长。',
    auto: '稍后自动重试。',
    action: '不用。',
    needsHuman: false,
  },
  'adjudicate-timeout': {
    title: '裁决运行超时一次，会自动重试',
    what: '给争议条目做裁决的那次运行超时了。',
    impact: '这个任务等裁决的时间会变长。',
    auto: '稍后自动重试。',
    action: '不用。',
    needsHuman: false,
  },
  'adjudicate-not-configured': {
    title: '有争议条目在等裁决，但没配裁决运行',
    what: '验收里有争议条目，但配置里没有裁决运行。',
    impact: '这个任务会一直停在等裁决。',
    auto: '已记下，等配置。',
    action: '需要：在配置里配上裁决运行，或人工裁决。',
    needsHuman: true,
  },
  'slack-history-failed': {
    title: '读不到 Slack 频道历史',
    what: '通知去重账本丢了，想从频道历史恢复，但读不到（缺权限或 bot 不在频道里）。',
    impact: '这之前的事件不补发；之后的新通知照常发。',
    auto: '已重建去重账本，从现在起照常发。',
    action: '需要：给 Slack app 补上读频道历史的权限，并确认 bot 在频道里。',
    needsHuman: true,
  },
  'board-claim-failed': {
    title: '看板没改成「验收中」',
    what: '认领任务后，项目看板上「验收中」没写成。',
    impact: '只是看板状态不准，验收照常进行。',
    auto: '验收照常继续。',
    action: '不用；介意的话可以手动改看板。',
    needsHuman: false,
  },
  'task-out-of-scope': {
    title: '任务涉及名单外的仓库，没派发',
    what: '这个任务树里有仓库不在验收机的允许名单里。',
    impact: '这个任务不会被验收。',
    auto: '已跳过，不派发。',
    action: '需要：如果它该验，把仓库加进名单；不该验就忽略。',
    needsHuman: true,
  },
  'passed-but-open': {
    title: '验收已通过，但 issue 还开着',
    what: '最新结论是「通过」，但关单没走完。',
    impact: '只是 issue 状态不准。',
    auto: '会对同一正文自动再跑一次收尾。',
    action: '先不用；一直开着请手动关。',
    needsHuman: false,
  },
  'egress-denied': {
    title: '沙箱里一次出网请求被拦下，属正常防护',
    what: '沙箱里的程序想连白名单外的地址，被出网代理拦下。',
    impact: '无影响：这是正常防护，验收照常。',
    auto: '已拦下并记日志。',
    action: '不用。',
    needsHuman: false,
  },
  'expected-gate-rejected': {
    title: '验收机一次读取被安全闸拦下，属正常防护',
    what: '验收机一次读取 / 写操作超出了允许范围，被写闸拦下。',
    impact: '无影响：这是正常防护，验收照常。',
    auto: '已拦下并记日志。',
    action: '不用。',
    needsHuman: false,
  },
});

const UNKNOWN_COPY = Object.freeze({
  title: '验收机报了一条还没归类的提醒',
  what: '',
  impact: '说不准，要看下面的原始记录。',
  auto: '只记了日志并发到这里，没做别的处理。',
  action: '需要：看一眼原始记录；拿不准就让修复员查。',
  needsHuman: true,
});

function copyTitle(type) {
  return NOTICE_COPY[type]?.title || UNKNOWN_COPY.title;
}

/** 动态句：interrupted-repeat / tick-failed-repeat 列出各 kind 的人话 title；loop-restarted 按 reason 细分。 */
function noticeCopy(event, type) {
  const base = NOTICE_COPY[type] ? { ...NOTICE_COPY[type] } : { ...UNKNOWN_COPY };
  if (!NOTICE_COPY[type]) {
    const name = type || 'alert';
    base.what = `验收机记了一条代码里还没写说明的提醒（代码名：${name}）。`;
  }
  if (type === 'loop-restarted') {
    const reason = str(event.reason);
    if (reason === 'heartbeat-stale') {
      base.title = '验收机心跳过期，已自动重新拉起';
      base.what = '调度循环好一阵没写心跳（疑似卡住）。';
    } else if (reason === 'loop-not-running') {
      base.title = '验收机调度循环挂了，已自动重新拉起';
      base.what = '调度循环进程不在了。';
    }
  }
  if (type === 'interrupted-repeat') {
    const count = Number(event.windowCount) || 0;
    const kinds = Array.isArray(event.windowKinds) ? event.windowKinds : [];
    const titles = kinds.map((item) => copyTitle(safeType(item) || '')).filter(Boolean);
    const listed = titles.length ? titles.join('、') : '中断类提醒';
    base.what = `这个任务 6 小时内中断了 ${count} 次（${listed}）。`;
  }
  if (type === 'tick-failed-repeat') {
    const count = Number(event.windowCount) || 0;
    const kinds = Array.isArray(event.windowKinds) ? event.windowKinds : [];
    const names = { 'tick-failed': '验收调度', 'prbot-tick-failed': '修正轮调度' };
    const listed = kinds.map((item) => names[safeType(item)] || '').filter(Boolean).join('、') || '调度';
    base.what = `${listed}在 10 分钟内连续出错 ${count} 次。`;
  }
  return base;
}

/** `secret-found` 的 reason 形如「…没推：a.js, b.txt」：只取冒号后面的文件名列表。 */
function secretFileList(reason) {
  const text = str(reason).trim();
  // 写闸的格式是「branch.push 扫到疑似密钥，没推：a.js, b.txt」：取第一个全角冒号后面（文件名里可能有半角冒号）。
  const at = text.indexOf('：');
  return (at >= 0 ? text.slice(at + 1) : text).trim();
}

function storySection(copy) {
  return section(
    [
      `*发生了什么*：${esc(copy.what)}`,
      `*有没有影响*：${esc(copy.impact)}`,
      `*验收机已自动做了什么*：${esc(copy.auto)}`,
      `*要不要人处理*：${esc(copy.action)}`,
    ].join('\n'),
  );
}

function fallbackText(copy, issue, needsHuman, extra = '') {
  const head = issue ? `${copy.title}：${issue}` : copy.title;
  const status = needsHuman ? '需要你处理' : '已自动处理，暂不用管';
  return extra ? `${head}｜${status}｜${extra}` : `${head}｜${status}`;
}

/**
 * 单条提醒（阻塞类 ping，或摘要里也用不到时单独发的那种）。
 * `secret-found` 只列文件名：reason 冒号前的话一个字都不带出去。
 * 通知栏文字只用固定文案 + 校验过的字段（safeRef、合规 PR 链接、数字），事件原文一律不进 text。
 */
export function alertBlocks(notice, profile) {
  const event = view(notice);
  const type = safeType(event.type) || safeType(event.kind) || 'alert';
  const copy = noticeCopy(event, type);
  const issue = safeRef(event.issue);
  const title = issue ? `${copy.title}：${issue}` : copy.title;
  const rawIssue = str(event.issue);
  const needsHuman = copy.needsHuman === true;
  const target = prLink(event);

  const blocks = [header(title), storySection(copy)];
  if (type === 'secret-found') {
    const files = secretFileList(event.reason);
    blocks.push(section(`文件名：${esc(files) || '（提醒里没给文件名）'}`));
    // 文件名可能是模型起的（比如就叫 `<!channel>`），只进转义过的 blocks，不进通知栏文字。
    const count = files ? files.split(',').filter((name) => name.trim()).length : 0;
    return finish({ text: `${title}｜${count} 个文件，文件名见消息｜需要你处理`, blocks }, profile);
  }
  if (type === 'gate-audit-violation') {
    // 明细（event.detail）每行一条违规，来自账本里的写入摘要：只进转义过的 blocks，不进通知栏文字。
    // reason 是机器摘要（已在标题和「发生了什么」里说清），不再贴「原始记录：」那一行。
    const rows = str(event.detail)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const count = Number(event.count) > 0 ? Number(event.count) : rows.length;
    const shown = rows.slice(0, AUDIT_DETAIL_LIMIT);
    const body = [`违规明细（共 ${count} 条，最多列 ${AUDIT_DETAIL_LIMIT} 条，其余见审计日志）：`];
    if (shown.length) body.push(...shown.map((line) => `· ${esc(line)}`));
    else body.push('（提醒里没给明细，见审计日志）');
    blocks.push(section(body.join('\n')));
    return finish({ text: `${title}｜${count} 条，明细见消息｜需要你处理`, blocks }, profile);
  }

  const lines = [];
  if (type === 'gate-rejected') {
    const reason = str(event.reason);
    if (reason) lines.push(`拦下原因：${esc(gateReasonText(reason))}（代码：${esc(reason)}）`);
    if (str(event.detail)) lines.push(`动作：${esc(str(event.detail))}`);
  } else {
    // loop-restarted 的已知原因已经写进标题和「发生了什么」，不再重复贴代码名。
    const knownLoopReason = type === 'loop-restarted' && ['heartbeat-stale', 'loop-not-running'].includes(str(event.reason));
    if (str(event.reason) && !knownLoopReason) lines.push(`原始记录：${esc(str(event.reason))}`);
    if (type === 'needs-human' && str(event.detail)) lines.push(`细节：${esc(str(event.detail))}`);
  }
  if (target.link) lines.push(`PR：${target.link}`);
  const sha = head7(event.headSha);
  if (sha) lines.push(`head：${sha}`);
  if (rawIssue && !issue) lines.push(`issue：${esc(rawIssue)}`);
  if (str(event.root) && str(event.root) !== rawIssue) lines.push(`任务 issue：${esc(str(event.root))}`);
  if (lines.length) blocks.push(section(lines.join('\n')));

  const extra = target.link ? target.link : '';
  return finish({ text: fallbackText(copy, issue, needsHuman, extra), blocks }, profile);
}

function digestLine(data) {
  const type = safeType(data.type) || safeType(data.kind) || 'alert';
  const copy = noticeCopy(data, type);
  const issue = str(data.issue);
  const issueBit = issue ? `（${esc(issue)}）` : '';
  let extra = '';
  if (type === 'gate-rejected') {
    const reason = str(data.reason);
    if (reason) extra = `（原始记录：${esc(gateReasonText(reason))}）`;
  } else {
    const reason = clip(str(data.reason), 140);
    if (reason) extra = `（原始记录：${esc(reason)}）`;
  }
  return `· ${esc(copy.title)}${issueBit}：${esc(copy.impact)} ${esc(copy.action)}${extra}`;
}

/**
 * 摘要：攒起来的多条合成一条。摘要**永远不 @**（这里根本没有 mention 参数）。
 * 每行人话标题 + 影响 + 要不要人处理；通知栏文字不出现 kind 代码名。
 */
export function digestBlocks(notices, profile) {
  const items = Array.isArray(notices) ? notices.filter(Boolean) : [];
  const lines = [];
  const heads = [];
  for (const item of items.slice(0, 40)) {
    const data = view(item);
    const type = safeType(data.type) || safeType(data.kind) || 'alert';
    const copy = noticeCopy(data, type);
    lines.push(digestLine(data));
    heads.push([copy.title, safeRef(data.issue)].filter(Boolean).join(' '));
  }
  if (items.length > 40) lines.push(`…还有 ${items.length - 40} 条`);
  const title = `验收机摘要（${items.length} 条，不紧急）`;
  const blocks = [header(title), section(lines.join('\n') || '（没有内容）')];
  const text = clip(`${title}：${heads.slice(0, 3).join('；')}`, 500);
  return finish({ text, blocks }, profile);
}

/** 当天碰到每日上限时发的那一条：不 @、不带事件内容。 */
export function capBlocks(cap, profile) {
  const count = Number.isInteger(cap) && cap > 0 ? cap : 0;
  const title = `今天的 Slack 通知已达上限（${count} 条）`;
  const blocks = [header(title), section('后面的事件不再单独发，攒进明天的第一条摘要；明天零点（本机时间）起重新计数。')];
  return finish({ text: `${title}｜后面的事件攒进明天的摘要`, blocks }, profile);
}
