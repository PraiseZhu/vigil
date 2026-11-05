// 单条精确读写的加载器：默认实现是 bin/prio-item.mjs（W4-d 提供），可能还没部署到这台机上。
// 这个文件可能不存在，所以只能动态 import —— 而 bin/*.mjs 上有静态检查禁止动态 import
// （防止绕开「bin 下不起子进程」的检查），那条规则不改，于是把这份加载单独放一个文件。
// 例外写在守卫自己身上了（#324 SC4）：watchers/acceptance/session-doc.test.mjs 的
// ALLOWED_DYNAMIC_IMPORT 显式列出本文件，并且只放行字面量 URL 那一种写法：
// `new URL(<字面量常量或字符串>, import.meta.url).href` 传给 import；别处再出现动态 import 守卫判失败。
// （守卫按纯文本数，注释里也不要再写字面量括弧形式的动态 import。）
// 除了一行动态 import 和一层错误翻译，这里不做事；调用方拿到 null 就当模块没部署。
export const SINGLE_ITEM_MODULE = './bin/prio-item.mjs';

/** 默认加载用的 URL。注入的 importer 也拿到同一个值，测试不用自己拼路径。 */
const DEFAULT_SPEC = new URL(SINGLE_ITEM_MODULE, import.meta.url).href;

/** 唯一的动态 import：写成守卫放行的字面量形状，所以不用传入参（入参恒等于 DEFAULT_SPEC）。 */
async function defaultImporter() {
  return import(new URL(SINGLE_ITEM_MODULE, import.meta.url).href);
}

/**
 * 加载单条读写模块。文件不在、或者没导出 syncEventItem，都返回 null（调用方据此只确认不写），
 * 其它加载错误照原样抛出去，不吞。
 * 取的是 #319 的适配层导出 syncEventItem（不是内部的 syncOneItem）：它认 #318 的 payload 形状
 * {repo, issue, ref, event, source, linkAllowed, now}，返回 {ok, written, planned, skipped, skippedByPolicy,
 * reason, cost, mode, partialPrs, linkAllowed}，调用方据此决定要不要 ack。
 * importer 只给测试注入：注入时调用注入的函数，语义和默认加载一致（同样只翻译「加载不到」）。
 */
export async function loadSingleItemModule({ importer = null } = {}) {
  const load = importer || defaultImporter;
  let mod;
  try {
    mod = await load(DEFAULT_SPEC);
  } catch (error) {
    const code = String(error?.code || '');
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(message)) {
      return null;
    }
    throw error;
  }
  return typeof mod?.syncEventItem === 'function' ? mod.syncEventItem : null;
}
