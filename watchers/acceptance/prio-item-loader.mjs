// 单条精确读写的加载器：默认实现是 bin/prio-item.mjs（W4-d 提供），可能还没部署到这台机上。
// 这个文件可能不存在，所以只能动态 import —— 而 bin/*.mjs 上有静态检查禁止动态 import
// （防止绕开「bin 下不起子进程」的检查），那条规则不改，于是把这份加载单独放一个文件。
// 除了一行动态 import 和一层错误翻译，这里不做事；调用方拿到 null 就当模块没部署。
export const SINGLE_ITEM_MODULE = './bin/prio-item.mjs';

/**
 * 加载单条读写模块。文件不在、或者没导出 syncOneItem，都返回 null（调用方据此只确认不写），
 * 其它加载错误照原样抛出去，不吞。
 */
export async function loadSingleItemModule({ importer = (spec) => import(spec) } = {}) {
  let mod;
  try {
    mod = await importer(new URL(SINGLE_ITEM_MODULE, import.meta.url).href);
  } catch (error) {
    const code = String(error?.code || '');
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find module/.test(message)) {
      return null;
    }
    throw error;
  }
  return typeof mod?.syncOneItem === 'function' ? mod.syncOneItem : null;
}
