# 接口说明

## 源码阅读与选择

编码前阅读了本地 `ref/feishu-raft-bridge` 0.4.2 的 `src/raft/client.ts`、`src/bridge/handler.ts`、`src/state/store.ts`、README 和许可证。参考项目为 MIT，Copyright 2026 CYZgo。

该项目使用 Raft CLI 的独立 profile 发消息，通过正文 `@handle` 唤醒执行 agent；线程目标格式为 `#channel:消息ID前8位`。它解析 CLI 输出读取回复，并用 journal/snapshot 保存映射、游标和去重记录，默认只回传指定执行 agent。

本版使用 `@botiverse/raft-sdk@0.32.0` 的 program layer，更适合普通 TypeScript 程序，也不需要 Windows CLI 安装和文本输出解析。接口已按安装包类型定义及真实调用核对：

| 接口 | 用途 |
| --- | --- |
| `createRaftClient` / `agent.context` | 使用 External Agent 凭据建立客户端、核对身份和权限 |
| `routes.channels.members/resolve` | 确认频道成员，解析频道和请求线程的真实 channel ID |
| `messages.send` | 携带稳定幂等键发送文本，仅 `state=sent` 视为确认成功 |
| `routes.threads.follow` | 关注新请求对应的线程 |
| `routes.mentions.senderDeliveries` | 查看 mention 是否投递给 agent |
| `events.receive` | 按 `ack: 'cursor'` 拉取 inbox，回传成功后推进游标 |

`since: 'latest'` 不会跳过历史排队消息。本版通过启动时间过滤旧消息，不补发停机期间的回复。不同 agent 的新回复均可回传，桥接不介入它们的任务协作。

## 多会话路由

企微 SDK `BaseMessage` 声明 `chatid` 仅群聊返回；`sendMessage(chatid, body)` 文档规定：私聊填 `from.userid`，群聊填 `chatid`。`WECOM_ALLOW_PRIVATE` 与 `WECOM_ALLOW_GROUP` 独立控制是否接收对应会话，均默认开启。移除固定群 ID 校验，访问范围由企微侧控制；Bot ID 校验仍保留。

群聊每次提问及首次私聊按 `@目标agent` 加正文发到固定 Raft 频道。发送成功后先保存来源会话，再 `threads.follow(#频道:消息ID前8位)`，用 `channels.resolve` 获取线程 channel ID。该解析方式已在本机现有线程上与 `threads.list` 返回的 `threadChannelId` 交叉核对。`RaftEvent` 没有父消息 ID 字段，因此使用其 `channelId` 精确匹配线程路由，不解析频道名、不使用批次的 `replyTarget` 猜测单条消息归属。

回传路由在内存最多保存 10,000 条。发送及轮询共用串行队列，避免快速回复先于路由注册被消费。线程关注/解析失败会在轮询时重试，不重新发送已确认的任务，未完成路由注册时不消费 inbox。只外发来源已知的线程回复；根频道、未知线程、缺少 channel ID 的消息记录 `raft_reply_unrouted` 并跳过。关闭某会话类型也会停止该类型的回传。重启时恢复持久化的私聊映射，群聊映射不恢复。

## 私聊固定线程

参考飞书 `handler.ts` 中“首次发送建立根消息，后续向 `existing.raftThreadTarget` 发送”的方式，按企微 `from.userid` 复用线程。飞书参考项目本身忽略私聊；这里独立实现企微私聊适配，不复制其卡片、历史同步或用户规则。会话查找在串行队列内进行，避免并发的第一、第二条消息各自创建根线程。

`PrivateSessions` 把用户 ID、根消息 ID、第一条来源消息标识写入 `.local/private-sessions/<scope>.json`。scope 是 Bot ID、Raft 地址、频道、桥接 handle、执行 handle 的哈希，不包含 token。写入使用临时文件、flush 和原子 rename；保存失败时保留内存映射并重试，恢复前暂停私聊后续提交和 inbox 消费。损坏文件、重复用户或跨用户线程冲突会阻止启动，原文件不覆盖。

后续消息调用 `messages.send`，其 `target` 为固定根消息的 `#channel:shortid`。首条回调重放时通过保存的来源标识识别，不把相同消息再发到它自己的 thread；其他重试保持原目标和幂等键。线程无法关注或解析时提示用户，绝不自动回退到频道创建新会话。没有超时或自动切换话题；上下文由 Raft agent 读取。

参考飞书 0.4.2 没有 `/new` 命令，其会话边界来自飞书话题。这里提供企微私聊的显式边界：整条无引用的 `/new`（不区分大小写）或“新话题”在串行队列内执行，先保存切换，再确认；下一条任务才创建根消息。失败时回滚当前映射，不宣称切换成功；不会向 Raft 发送重开命令。群聊只提示现有的逐条新建规则。

状态格式升级到 version 2，并兼容读取 version 1。保留当前私聊映射、最近 1,000 个旧线程路由和最近 1,000 条重开来源标识；回调重放不会再次切换最近已完成的重开操作，旧根消息重放也不会成为新任务。旧线程继续恢复回传，不取消 agent 的在途工作，不改变其历史访问权限。重开命令只在本次提问正文独立匹配，引用和普通句子中的命令不执行。

本次只持久化私聊映射，不实现完整 journal、停机期间补发或群聊恢复。外部发送成功但私聊映射尚未落盘时仍存在崩溃窗口；原消息再次投递可依赖稳定幂等键恢复根消息，但不能据此承诺任意崩溃场景都不丢状态。

企微使用 `@wecom/aibot-node-sdk@1.0.7`：订阅 `message.text`，正常任务提交不调用 `replyStream`，不发送提交确认或创建空的回复流。投递失败、空任务、队列已满和重开命令的反馈，通过 `replyStream` 和原始 `req_id` 回复提示并结束该流。agent 回复通过 `sendMessage` 主动回群，检查发送回执。主动推送用 SDK 支持的 `markdown` 载荷展示文本，不使用卡片或附件。是否只发送最终结论由 Raft agent 的频道约定决定，桥接不按文本猜测或过滤进度消息。

## 跨平台启动管理

参考飞书的 `bin/start.sh` 和 `main.ts` 的单实例检查思路，独立实现 `scripts/bridge.mjs` 与 `runtime.mjs`；不复制其 Bash/macOS `caffeinate` 行为。Windows `.cmd` 和 POSIX `.sh` 只定位并启动 Node.js，平台相关文件路径和子进程均交给 Node 标准库。启动器不依赖 tsx 即可显示状态及安装提示；工作进程用已安装的 tsx loader 运行 TypeScript。

工作进程在访问 Raft、连接企微前绑定 `127.0.0.1` 控制端口，以操作系统的独占 bind 防止同一项目并发启动；端口由规范化项目路径哈希确定（40000–59999）。发生端口冲突时拒绝启动，不结束占用者、不切换端口绕过锁。状态读取校验应用及路径；停止须携带 `.local/bridge-control.json` 内每次启动生成的随机 token，通知现有进程走 drain/disconnect。该文件只含本地控制凭据和进程元数据，不含企微、Raft 凭据，且已被 Git 忽略。PID 只用于显示，不据此结束任何进程；崩溃残留文件可在下一次成功 bind 后覆盖。

`npm start` 前台运行，`npm run start:bg` 使用独立后台进程并追加日志；`stop` 和 `status` 在三种操作系统上保持相同语义。主入口即使通过 tsx 直接运行或进入 discover 模式，也必须取得相同的锁。`check` 不建立企微连接，因此可以与主服务同时运行。状态中的“企微已认证”描述当前企微连接；不表示每一条任务都已完成，也不持续探测 Raft 健康。

不安装系统服务或自动启动项，不阻止电脑休眠。macOS/Linux 的退出登录策略及系统休眠仍可能停止或暂停进程；需要长期服务时由维护者另行配置运行环境。多目录/多机器的同 bot 冲突不在本地锁的检测范围；升级前已经运行的旧版本需先自行停止。

## 引用提问

企微[接收消息协议](https://developer.work.weixin.qq.com/document/path/100719)和 SDK `QuoteContent` 定义了 `quote.text.content` 等引用内容字段；长连接文档说明消息体结构沿用该协议。桥接从当前 `message.text` 回调读取 `quote`，提取文本或图文混排中的文字，以 Markdown 引用块与本次问题分开呈现。空引用及未接入的媒体引用用简短占位说明，不把资源 URL 当作正文或下载资源。

引用中的 ASCII agent mention 使用全角 `＠` 展示，避免历史提及再次唤醒 agent；本次问题的 mention 和邮箱保持原样。引用不改变路由：私聊使用固定线程，群聊独立发起任务；不凭引用文字猜测旧任务 ID。日志仅增加 `hasQuote` 标记，不记录引用正文。

本次只使用长连接消息回调携带的引用内容。其他 MCP 可能提供历史读取能力，未在此项目核实或接入；不据当前长连接接口的字段推断整个企微平台没有历史能力。

代码为本项目独立实现，参考上述桥接思路；未复制原项目的状态存储、飞书业务逻辑或 agent 行为规则。第三方包遵循各自许可证；原参考项目及其许可证仍留在本地 `ref/`，不加入此 Git 仓库。

参考：[企微 SDK](https://github.com/WecomTeam/aibot-node-sdk)、[企微官方协议](https://developer.work.weixin.qq.com/document/path/101463)、[Raft External Agent](https://docs.raft.build/developers/sdk/external-agents/)。

## 日志与排错

| 事件 | 意义 |
| --- | --- |
| `raft_ready` | 身份、频道和执行 agent 检查通过 |
| `wecom_authenticated` | 企微长连接认证成功 |
| `bridge_modes` | 当前私聊/群聊开关 |
| `private_sessions_loaded` | 启动时加载的私聊会话数 |
| `private_session_unavailable` / `private_session_save_failed` | 原私聊无法恢复 / 已提交但映射保存失败 |
| `private_session_reset` / `private_session_reset_failed` | 私聊重开已保存 / 保存失败，保留原话题 |
| `wecom_conversation_discovered` | 排错模式下收到的私聊/群聊元数据 |
| `wecom_received` / `raft_posted` | 收到企微消息 / Raft 已确认发送 |
| `raft_mention_delivery` | mention 投递状态；`pending` 尚未确认，`delivered` 已投递 |
| `wecom_forwarded` | 企微已确认收到一段回复 |
| `raft_send_failed` / `raft_poll_failed` | Raft 发送或读取错误 |
| `raft_route_ready` / `raft_route_pending` | 线程来源路由建立成功 / 待重试 |
| `raft_reply_unrouted` | 回复缺少已知的来源线程，不外发 |
| `wecom_*_failed` / `wecom_error` | 企微回复或连接异常 |

无需群 ID。收不到消息时先检查企微白名单及对应会话开关；Raft 有回复但没有回传时，确认是在本次运行发起的任务 thread 内回复。401/403 请检查凭据是否撤销、权限和频道成员身份；身份不匹配请核对 `RAFT_EXPECTED_AGENT`。企微认证失败时检查 Bot ID/Secret、API 长连接模式及是否还有第二个同 bot 进程。

日志保留消息关联 ID 和安全错误状态，不打印密钥、请求体或完整聊天内容。消息 ID 用于排错和幂等处理，不会添加到 Raft 正文。
