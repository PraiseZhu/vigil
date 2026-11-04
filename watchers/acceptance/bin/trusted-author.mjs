// 身份白名单：评论 / issue 只认「本人（ownerLogin）+ 配置的 App bot（trustedBotLogins）」发的。
// 公开仓上任何人都能发同样首行的评论，所以这里一律整串相等：不用 startsWith / includes，
// 「praise-priority[bot]x」「xpraise-priority[bot]」这类冒充不会被放行；比较前先 trim，大小写不敏感。
// bot 名单项必须带 [bot] 后缀：profile 加载时校验（普通用户名混进来等于把别人发的评论当本人），
// 这里再挡一次，手工拼出来的 profile 也骗不过去。
// GitHub 的类型拿得到时（GraphQL 里选 author { __typename }，夹具也可能直接给 type）要求 bot 项必须是 'Bot'；
// 老数据 / 注入的夹具里没有类型信息时只按 login 命中放行，不因为缺类型就停掉整台验收机。

/** App bot 登录名：`<name>[bot]`，名字部分只收 GitHub 登录名允许的字符。 */
export const BOT_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\[bot\]$/;

export function isBotLogin(login) {
  return typeof login === 'string' && BOT_LOGIN_PATTERN.test(login.trim());
}

/** 第二个参数既可以是 profile 对象（带 ownerLogin / trustedBotLogins），也可以只给 ownerLogin 字符串。 */
function normalizeProfile(profile) {
  if (typeof profile === 'string') return { owner: profile, bots: [] };
  const owner = typeof profile?.ownerLogin === 'string' ? profile.ownerLogin : '';
  const bots = Array.isArray(profile?.trustedBotLogins)
    ? profile.trustedBotLogins.filter((item) => typeof item === 'string' && item)
    : [];
  return { owner, bots };
}

/** 作者对象上的类型：GraphQL 的 `__typename`，夹具也可能直接给 `type`。 */
function authorTypeOf(author) {
  if (!author || typeof author !== 'object') return undefined;
  const value = author.__typename ?? author.type;
  return typeof value === 'string' && value ? value : undefined;
}

function readAuthor(input, typeOption) {
  if (input && typeof input === 'object') {
    return { login: typeof input.login === 'string' ? input.login : '', type: typeOption ?? authorTypeOf(input) };
  }
  return { login: typeof input === 'string' ? input : '', type: typeOption };
}

/**
 * 这个作者是不是可信身份：login 整串等于 ownerLogin，或整串等于 trustedBotLogins 的某一项。
 * 第一个参数可以给登录名，也可以直接给作者对象（`{ login, __typename }`，老夹具只有 `{ login }`）。
 * 类型可得时：bot 名单项必须 type === 'Bot'；ownerLogin 是账号本人，type === 'Bot' 反而不放行。
 * login 为空 / 不是字符串、名单为空、冒充字符串一律拒绝。
 */
export function isTrustedAuthor(input, profile, { type } = {}) {
  const author = readAuthor(input, type);
  const login = author.login.trim().toLowerCase();
  if (!login) return false;
  const { owner, bots } = normalizeProfile(profile);
  const isBotType = author.type === 'Bot';
  const ownerKey = owner.trim().toLowerCase();
  if (ownerKey && login === ownerKey) return !isBotType;
  if (!bots.some((item) => isBotLogin(item) && item.trim().toLowerCase() === login)) return false;
  // 类型拿得到但不是 Bot：这条不是 App bot 发的，不放行。
  if (author.type !== undefined && !isBotType) return false;
  return true;
}
