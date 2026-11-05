// Cloudflare Worker 部署入口：请求原样转给唯一一个 Durable Object 实例（idFromName('main')）。
// 队列、去重表、告警都在那一份存储里，Worker 换实例或两个请求同时到，也不会各看各的内存。
// 这里不存任何东西，也不读 GitHub 令牌。密钥只有 WEBHOOK_SECRET 和 PULL_TOKEN，
// 用 wrangler secret put 写进 Worker（见 README.md），不进这个仓库。
// /webhook、/pull、/ack、/fail 的处理和签名校验都在 bin/event-worker.mjs，这里只转发，不改事件语义。
export { EventChannelDurableObject } from '../bin/event-worker.mjs';

// 单实例的名字。改它等于换一份空队列，上线后不要再改。
const INSTANCE_NAME = 'main';

export default {
  async fetch(request, env) {
    const channel = env?.EVENT_CHANNEL;
    // 绑定缺失时明确报 500。不能静默放过：webhook 会被 GitHub 判成失败而重投，队列也拿不到。
    if (!channel || typeof channel.idFromName !== 'function' || typeof channel.get !== 'function') {
      return new Response('missing EVENT_CHANNEL binding', { status: 500 });
    }
    const stub = channel.get(channel.idFromName(INSTANCE_NAME));
    if (!stub || typeof stub.fetch !== 'function') {
      return new Response('missing EVENT_CHANNEL binding', { status: 500 });
    }
    return stub.fetch(request);
  },
};
