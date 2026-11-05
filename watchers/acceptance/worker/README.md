# 事件通道 Worker（部署入口）

`bin/event-worker.mjs` 里的队列和去重逻辑跑在 Cloudflare 上时，需要一个 Worker 入口和一个 Durable Object。
这个目录就是那层入口，不含任何业务逻辑：

- `index.mjs`：导出 `EventChannelDurableObject`（复用 `bin/event-worker.mjs`），默认 fetch 把请求原样转给
  `env.EVENT_CHANNEL.idFromName('main')` 拿到的**唯一一个** DO 实例。Worker 层不存任何东西。
- `wrangler.toml`：Worker 名、DO 绑定 `EVENT_CHANNEL`、SQLite 后端的迁移。不放密钥、不放自定义域、不用 Cron。
- 事件路由（`/webhook`、`/pull`、`/ack`、`/fail`）、签名校验、去重都还在 `bin/event-worker.mjs`，这里不改语义。

免费档只能用 SQLite 后端的 Durable Object，所以迁移必须是 `new_sqlite_classes`。改成 `new_classes` 在免费账号上建不出来。

## 前置（账号级，需要先放行）

1. 该 Cloudflare 账号要有一个 `workers.dev` 子域名。没有的话首次部署会失败（错误码 10007），先在控制台注册一个。
2. 本机要有一枚能部署 Worker 和 Durable Objects 的 API token（Workers Scripts:Edit、Durable Objects:Edit），
   以及账号 id。凭证不要写进这个仓库，也不要进命令历史。

## 部署

在本目录下执行，命令里的值都从本机凭据文件读，不要直接敲在命令行里：

```sh
cd watchers/acceptance/worker
npx wrangler --version            # 首次会临时下载，不进 package.json 依赖
npx wrangler deploy               # 首次部署会执行 migrations 里的 v1
```

`deploy` 之后 Worker 的地址形如 `https://<name>.<账号子域>.workers.dev`。
GitHub App 的 webhook URL 要填这个地址加 `/webhook`（改 App 设置属于账号级操作，单独放行）。

## 两个 secret

代码只读两个密钥，都用 `wrangler secret put` 写进 Worker，值只来自本机 600 权限的文件：

```sh
# 值从文件读进变量，再由 stdin 喂给 wrangler：不进仓库、不进 shell 历史、不回显
SECRET_VALUE="$(cat <本机 600 权限密钥文件路径>)"; printf '%s' "$SECRET_VALUE" | npx wrangler secret put WEBHOOK_SECRET; unset SECRET_VALUE
SECRET_VALUE="$(cat <本机 600 权限令牌文件路径>)"; printf '%s' "$SECRET_VALUE" | npx wrangler secret put PULL_TOKEN; unset SECRET_VALUE
```

- `WEBHOOK_SECRET`：GitHub App webhook 的 secret，用来校验 `X-Hub-Signature-256`。填错等于所有 webhook 都 401。
- `PULL_TOKEN`：本机拉取端（`event-pull.mjs`）带在 `Authorization: Bearer` 里的令牌。

除这两个之外没有别的密钥。这里不放 GitHub 令牌：Worker 不出站、不调 GitHub API。

## 部署后冒烟（必做，别跳）

冒烟要验证两件事：队列真的落在 DO 上；SQLite 版 DO 的事务回调不再传 `txn` 时代码还能写。

```sh
BASE='https://<name>.<账号子域>.workers.dev'

# 1) 空队列：应返回 {"events":[],"alerts":[]}；401 说明 PULL_TOKEN 没对上
curl -sS -H "authorization: Bearer $PULL_TOKEN" "$BASE/pull"

# 2) 发一条假 webhook：签名用同一份 WEBHOOK_SECRET 算，2026 之外的数字随意
BODY='{"created_at":"2026-10-31T00:00:00.000Z","action":"opened","repository":{"full_name":"example-org/example-repo"}}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -r | cut -d' ' -f1)"
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/webhook" \
  -H 'content-type: application/json' \
  -H "x-hub-signature-256: $SIG" \
  -H 'x-github-delivery: smoke-1' \
  -H 'x-github-event: pull_request' \
  --data "$BODY"          # 期望 204；401 说明签名 secret 不对

# 3) 再拉一次：应拿到 deliveryId 为 smoke-1 的事件。拿不到说明事务写没落盘（txn 适配没生效）
curl -sS -H "authorization: Bearer $PULL_TOKEN" "$BASE/pull"

# 4) 收尾：确认掉这条，别留在队列里
curl -sS -o /dev/null -w '%{http_code}\n' -X POST "$BASE/ack" \
  -H "authorization: Bearer $PULL_TOKEN" -H 'content-type: application/json' \
  --data '{"ids":["smoke-1"]}'   # 期望 204
```

第 3 步是这次部署唯一的硬判据。如果第 2 步 500 而日志里报 `storage.transaction` 或 `list` 之类，
先看 `bin/event-worker.mjs` 的 `runInTransaction` 是否真的被用上。

## 事件收窄在哪做

Worker **不**按事件名过滤：`bin/event-worker.mjs` 收到什么就排什么队（只有签名、delivery id 去重、队列上限）。
收窄订阅范围要在 GitHub App 设置页的事件订阅里只勾这几类：`pull_request`、`pull_request_review`、`issues`、
`issue_comment`。不要在 Worker 里加白名单，那样会改事件语义，也会让日志和队列对不上账。

## 回滚

```sh
npx wrangler delete            # 删 Worker、DO 和它的全部队列/去重表；两个 secret 跟着没
```

删掉之后拉取端会连不上，自动退回 60 秒兜底轮询（见 `bin/event-pull.mjs`），30 分钟 cron 那条路不受影响。
GitHub App 的 webhook URL 要另行改回原值，否则 GitHub 会持续重投失败。

## 额度与限制

免费档：Worker 100,000 请求/天；DO 请求 100,000/天、时长 13,000 GB-s/天、行读 5,000,000/天、行写 100,000/天。
超限是报错不扣钱。队列最多 1000 条，单条值 128 KiB，超出的只留元数据。请求体另有上限：`/webhook` 512 KiB、
`/ack` 64 KiB、`/fail` 8 KiB，超了直接 413（见 `bin/event-worker.mjs` 里的 `WEBHOOK_BODY_LIMIT` 等常量）。

**行读比请求数先打满。** `/pull` 每次都 `list('q:')` 把整个队列读一遍、再 `list('a:')` 读告警，行读按返回的键数计，
所以一次 `/pull` 的行读约等于「队列长度 N + 告警条数 A」（A ≤ 50）。2 秒一拍 = 43,200 次/天，于是：

| 队列 N | 告警 A | 行读/天 | 占 5,000,000 |
|---|---|---|---|
| 0 | 0 | 0 | 0 |
| 20 | 3 | 993,600 | 20% |
| 115 | 1 | 5,011,200 | 100%（临界） |
| 1000 | 50 | 45,360,000 | 907% |

结论：请求数一天固定 43,200（占 100,000 的 43%，离上限还远），**行读的临界点是每次 `/pull` 的
队列 + 告警平均不超过 115 行**。队列长期积压在一百条以上时，先撞的是行读，不是请求数。这个 5,000,000 是
账号级的，会跟同一个账号下别的 Worker 共用。

行写按每次收事件 5 次 put 估（`seq`、去重 `s:`、`seenCount`、队列 `q:`、`queueCount`；队列满时改记告警，
另算 `alertSeq` / `a:` / `alertCount`），100,000/天 ÷ 5 ≈ 20,000 条事件/天，是行写这一侧的粗略上界。

`/ack`、`/fail` 也各整队 `list('q:')` 一次（`readQueue`）：`/ack` 每次一条，`/fail` 每条失败事件一条，
队列越长这两条路线的行读越高。

以上数字是照代码里的 `list` / `put` 次数推的，没在真实账号上量过（空队列的 `list` 是否仍计 1 行读也不确定，
不影响量级）。降行读的办法是给 `/pull` 加分页（`?after=seq&limit`），那要同时改本机拉取端协议，本轮没做。

## 边界与已知取舍

- **请求体上限**：`/webhook` 的 512 KiB 不是照 GitHub 的 25 MB 上限拍的，而是照这条通道实际存得下多少：
  入队时每条事件写一个存储值，超过 128 KiB 就只留元数据（delivery id、事件名、仓库、编号），所以收更大的
  body 只换来一次 `JSON.parse`。512 KiB = 4 × 128 KiB，足够收下任何能被完整存储的事件。真实 PR 事件是否常超
  512 KiB：未测（没有线上流量采样）；真超了也只是落成元数据，事件本身不丢。超限时先看 `content-length`
  快速拒（413），没有该头或声明偏小时按读到的累计字节数兜底，`/webhook` 的 413 在验签之前返回，不回显 body。
- **旧事件晚到**那条用例（`event-channel.test.mjs` 里「旧事件晚到时不被丢弃、不顶掉已入队的新事件」）是
  characterization：它只锁定当前行为——按到达顺序入队、按到达顺序交付，不按 `created_at` 重排、不丢弃。
  晚到事件的 `created_at` 比队列里已有的更早，验收侧按时间判断状态时要自己处理这种顺序。
- **去重键不在签名里**：`X-Hub-Signature-256` 覆盖的是 body，`X-GitHub-Delivery` 只是同一条请求的另一个头。
  拿到签名和 body 的人换一个 delivery id 就能让同一条事件再入队一次。去重只防 GitHub 重投和本机重复拉取，
  不是防重放机制；密钥泄露的边界是 `WEBHOOK_SECRET` 本身。

## 未验证（别当结论用）

- **真实 Durable Object 上的冒烟没做过**：本目录的测试只模拟 `storage` 接口，证明不了线上事务回调的实际行为。
  上面「部署后冒烟」第 3 步就是补这个缺口。
- **免费额度的实际消耗没测**：上面「额度与限制」的表格是按 `list` / `put` 次数推的估算，没有真实账号上的行读/
  行写用量数据。`workers.dev` 子域名是否已注册、账号有没有可用的部署凭证、`wrangler deploy` 在这台机器上
  能不能跑通：也都没验证。
- 2 秒拉取下的实际 DO 时长与 CPU（10 ms/请求的限制会不会踩 1102）：没测。
