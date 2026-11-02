# 企业微信 ↔ Raft 文本桥接

把企微私聊或群聊发给智能机器人的文本交给 Raft agent，再把 agent 回复送回发起任务的会话。桥接用独立 External Agent 身份运行，不调用模型、不执行任务、不调度 agents。

本机配置：`StoryLoom客服 → #StoryLoom_Wecom → @Sol`，桥接身份为 `@WeCom`。私聊、群聊默认均开启；允许哪些人或群使用，由企业微信侧的白名单控制。

## 启动

需要 Node.js 22+。在项目目录运行：

```powershell
npm ci
# 仅首次安装时复制；本机已有 .env，不要覆盖。
Copy-Item .env.example .env
# 编辑 .env 填写配置后：
npm run check
npm start
```

本机凭据已放在 `.env`，直接 `npm start` 即可。`npm run check` 只验证 Raft 身份、频道和目标 agent，不发消息。停止服务用 `Ctrl+C`；同一个机器人同时只运行一个进程。

## 配置

程序只读取 `.env` 和环境变量（环境变量优先），不再读取 `bot.txt` 或 `token.txt`。

| 变量 | 用途 |
| --- | --- |
| `WECOM_BOT_ID` | 智能机器人 Bot ID |
| `WECOM_SECRET` | 智能机器人 Secret |
| `WECOM_ALLOW_PRIVATE` | 是否接收私聊，`true` / `false`，默认 `true` |
| `WECOM_ALLOW_GROUP` | 是否接收群聊，`true` / `false`，默认 `true` |
| `WECOM_BOT_NAME` | 群内机器人显示名，用于去掉开头的 mention |
| `RAFT_SERVER_URL` | Raft 服务地址 |
| `RAFT_AGENT_CREDENTIAL` | 桥接身份的 `sk_agent_...` 凭据 |
| `RAFT_CHANNEL` | 固定频道，例如 `#StoryLoom_Wecom` |
| `RAFT_TARGET_AGENT` | 默认执行 agent，例如 `@Sol` |
| `RAFT_EXPECTED_AGENT` | 桥接身份，例如 `@WeCom`，启动时校验 |
| `RAFT_POLL_MS` | Raft 轮询间隔，默认 2000 毫秒 |

`.env`、旧凭据 txt、运行日志、`node_modules/`、`.local/` 和参考源码 `ref/` 均被 Git 忽略。仓库只提交不含密钥的 `.env.example`。无需模型 API Key、公网回调地址或内网穿透。

## 私聊和群聊

私聊直接发文本；群聊从企微的 @ 菜单选中机器人后发文本。新群只需在企微侧允许使用并加入同一机器人，无需发现或填写群 ID。原来的 `WECOM_CHAT_ID` 已不再读取。

例如只接收群聊，在 `.env` 设置后重启：

```dotenv
WECOM_ALLOW_PRIVATE=false
WECOM_ALLOW_GROUP=true
```

设为 `false` 的消息类型会静默忽略，两个开关都可关闭。仅接受当前 Bot ID 的回调，不另设用户或群白名单。

`npm run discover` 保留为排错工具：先停止主服务，再运行它，观察私聊/群聊回调是否抵达。它只记录会话类型、会话 ID、发送者 ID 和消息 ID，不执行或回传任务。

## 消息效果

在企微发送 `@StoryLoom客服 请检查这个问题`，Raft 中会收到：

```text
@Sol

请检查这个问题
```

不再附加来源标签、发送者 ID 或消息 ID。`@Sol` 用于触发执行 agent；正文中的邮箱、代码和其他 mention 保留。

每条企微消息在同一 Raft 频道发起一条任务，并关注该消息的 thread。桥接在内存中关联线程 ID 与来源会话；Sol 和其他协作 agent 在该 thread 中的回复只送回对应的群或私聊。每条新输入独立发起任务，目前不自动把后续追问续到上一条 thread。

**Sol 必须在任务对应的 thread 中回复。** 直接发在频道里的消息、未知线程中的消息，即使 `@WeCom` 也无法确定接收方，因此不会转发；不会广播给所有群或发送给最近联系的人。

正常提交时不发送确认或进度提示，回复以 `[Sol] 回复内容` 等形式返回，长文本自动分段。投递失败、空任务或队列已满时仍会提示。过滤桥接自身、人类、系统和其他频道的消息。

可在 Raft 频道告诉 Sol：

> 本频道接入了多个企微群和私聊。请始终在每条任务消息对应的 thread 中回复，完成后一次性给出结论和必要依据。不要发送“收到”“我先检查一下”等开工或进度消息。需要补充信息或遇到阻塞时，在同一 thread 简短说明。用户明确要求进度时再提供。

这条约定由 agent 遵循；桥接不会判断哪条是最终结论，agent 发送的进度消息仍会回传。

## 当前边界

- 仅文本、多企微会话对应一个固定 Raft 频道；没有附件、卡片、后台或数据库。
- 所有任务仍进入同一个 Raft 频道，其成员可以读取这些任务；来源会话路由只负责把回复送到正确的位置。
- 去重、排队、线程路由和游标只保存在内存。保留最近 10,000 个线程路由；发送重试复用由 bot、会话类型、会话 ID 和消息 ID 派生的幂等键。
- 回传失败不推进 Raft 游标；已成功发送的分段不重复发送。回执丢失仍可能产生重复，不承诺 exactly-once。
- 重启会清空队列及线程路由；重启前已发起任务的后续回复也不会自动回传，需要重新发起任务。休眠或退出程序后桥接停止。
- 回传依赖桥接身份的 inbox。桥接会关注自己发起的任务线程；关注或解析线程失败时保留待处理路由，重试期间不消费回复，也不重复发起已提交的任务。
- 各种 ID 仅用于程序内部关联及投递日志，不附加到聊天正文。日志默认写标准输出，可用 `npm start *> bridge.log` 保存。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run check
```

测试使用本地 mock 和 WebSocket 服务，不使用真实凭据或触发 Sol。覆盖两群、两私聊交错回信，开关组合，去重，线程注册竞态，失败重试和两种企微回调格式。

真实验收：先告知 Sol 上述 thread 规则，再在两个群及私聊分别发不同的测试文本，检查回复只返回各自的会话。单次测试可发送“请在本条任务的 thread 里只回复‘桥接正常’”。

```text
src/                   配置、两端适配、桥接逻辑和入口
test/                  离线测试及 SDK 协议验证
docs/architecture.md   接口依据、源码阅读结论和排错
docs/validation.md     验证记录
.env.example           无密钥配置模板
```

Raft 的选择依据及常见日志见 [接口说明](docs/architecture.md)，实测结果见 [验证记录](docs/validation.md)。
