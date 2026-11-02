# 企业微信 ↔ Raft 文本桥接

把一个固定企微群发给智能机器人的文本交给 Raft agent，再把 agent 回复送回群里。桥接用独立 External Agent 身份运行，不调用模型、不执行任务、不调度 agents。

目前本机绑定的是**测试群**：`StoryLoom客服 → #StoryLoom_Wecom → @Sol`，桥接身份为 `@WeCom`。

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

本机的凭据和群绑定均已放在 `.env`，直接 `npm start` 即可。`npm run check` 只验证 Raft 身份、频道和目标 agent，不发消息。停止服务用 `Ctrl+C`；同一个机器人同时只运行一个进程。

## 配置

程序只读取 `.env` 和环境变量（环境变量优先），不再读取 `bot.txt` 或 `token.txt`。

| 变量 | 用途 |
| --- | --- |
| `WECOM_BOT_ID` | 智能机器人 Bot ID |
| `WECOM_SECRET` | 智能机器人 Secret |
| `WECOM_CHAT_ID` | 唯一允许转发的企微群 ID |
| `WECOM_BOT_NAME` | 群内机器人显示名，用于去掉开头的 mention |
| `RAFT_SERVER_URL` | Raft 服务地址 |
| `RAFT_AGENT_CREDENTIAL` | 桥接身份的 `sk_agent_...` 凭据 |
| `RAFT_CHANNEL` | 固定频道，例如 `#StoryLoom_Wecom` |
| `RAFT_TARGET_AGENT` | 默认执行 agent，例如 `@Sol` |
| `RAFT_EXPECTED_AGENT` | 桥接身份，例如 `@WeCom`，启动时校验 |
| `RAFT_POLL_MS` | Raft 轮询间隔，默认 2000 毫秒 |

`.env`、旧凭据 txt、运行日志、`node_modules/`、`.local/` 和参考源码 `ref/` 均被 Git 忽略。仓库只提交不含密钥的 `.env.example`。无需模型 API Key、公网回调地址或内网穿透。

## 绑定或更换群

1. 先停止正在运行的桥接，把机器人加入目标内部群，确保已启用 API 模式的 WebSocket 长连接。
2. 执行 `npm run discover`，等到日志出现 `wecom_authenticated`。
3. 在目标群 `@机器人` 发一句话，从 `wecom_group_discovered` 日志复制 `chatId`。
4. 按 `Ctrl+C` 停止发现模式，将群 ID 和机器人显示名填入 `.env`，再执行 `npm start`。

发现模式只打印群、用户、消息 ID，不执行或回传任务。切换到正式群时重复上述流程；只有 `.env` 中配置的群会被转发。

## 消息效果

在企微发送 `@StoryLoom客服 请检查这个问题`，Raft 中会收到：

```text
@Sol

请检查这个问题
```

不再附加来源标签、发送者 ID 或消息 ID。`@Sol` 用于触发执行 agent；正文中的邮箱、代码和其他 mention 保留。

Raft 确认发送成功后，企微只收到一句“已交给 @Sol。”，不显示“正在提交”等中间状态。agent 的回复以 `[Sol] 回复内容` 等形式回群，长文本自动分段。只回传目标频道及已关注线程中的新 agent 文本，过滤桥接自身、人类、系统和其他频道的消息。

## 当前边界

- 仅文本、一个固定群和频道；没有附件、卡片、后台或数据库。
- 去重、排队和游标只保存在内存；发送重试复用由来源消息 ID 派生的幂等键。
- 回传失败不推进 Raft 游标；已成功发送的分段不重复发送。回执丢失仍可能产生重复，不承诺 exactly-once。
- 重启会清空队列，启动前的回复不补发；休眠或退出程序后桥接停止。
- 回传依赖桥接身份的 inbox。桥接会关注自己发起的任务线程；其他独立线程需要关注或 `@WeCom`，目标频道请不要静音。
- 各种 ID 仅用于程序内部关联及投递日志，不附加到聊天正文。日志默认写标准输出，可用 `npm start *> bridge.log` 保存。

## 开发与验证

```powershell
npm run typecheck
npm test
npm run check
```

测试使用本地 mock 和 WebSocket 服务，不使用真实凭据或触发 Sol。真实验收可在测试群发送 `@机器人 请只回复“桥接正常”`，检查是否返回 `[Sol] 桥接正常`。

```text
src/                   配置、两端适配、桥接逻辑和入口
test/                  离线测试及 SDK 协议验证
docs/architecture.md   接口依据、源码阅读结论和排错
docs/validation.md     验证记录
.env.example           无密钥配置模板
```

Raft 的选择依据及常见日志见 [接口说明](docs/architecture.md)，实测结果见 [验证记录](docs/validation.md)。
