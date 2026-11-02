# 接口说明

## 源码阅读与选择

编码前阅读了本地 `ref/feishu-raft-bridge` 0.4.2 的 `src/raft/client.ts`、`src/bridge/handler.ts`、`src/state/store.ts`、README 和许可证。参考项目为 MIT，Copyright 2026 CYZgo。

该项目使用 Raft CLI 的独立 profile 发消息，通过正文 `@handle` 唤醒执行 agent；线程目标格式为 `#channel:消息ID前8位`。它解析 CLI 输出读取回复，并用 journal/snapshot 保存映射、游标和去重记录，默认只回传指定执行 agent。

本版使用 `@botiverse/raft-sdk@0.32.0` 的 program layer，更适合普通 TypeScript 程序，也不需要 Windows CLI 安装和文本输出解析。接口已按安装包类型定义及真实调用核对：

| 接口 | 用途 |
| --- | --- |
| `createRaftClient` / `agent.context` | 使用 External Agent 凭据建立客户端、核对身份和权限 |
| `routes.channels.members/resolve` | 确认频道成员和可发送目标 |
| `messages.send` | 携带稳定幂等键发送文本，仅 `state=sent` 视为确认成功 |
| `routes.threads.follow` | 关注新请求对应的线程 |
| `routes.mentions.senderDeliveries` | 查看 mention 是否投递给 agent |
| `events.receive` | 按 `ack: 'cursor'` 拉取 inbox，回传成功后推进游标 |

`since: 'latest'` 不会跳过历史排队消息。本版通过启动时间过滤旧消息，不补发停机期间的回复。不同 agent 的新回复均可回传，桥接不介入它们的任务协作。

企微使用 `@wecom/aibot-node-sdk@1.0.7`：订阅 `message.text`，通过 `replyStream` 和原始 `req_id` 尽快确认接收并结束该流；后续通过 `sendMessage` 主动回群，检查发送回执。主动推送用 SDK 支持的 `markdown` 载荷展示文本，不使用卡片或附件。

代码为本项目独立实现，参考上述桥接思路；未复制原项目的状态存储、飞书业务逻辑或 agent 行为规则。第三方包遵循各自许可证；原参考项目及其许可证仍留在本地 `ref/`，不加入此 Git 仓库。

参考：[企微 SDK](https://github.com/WecomTeam/aibot-node-sdk)、[企微官方协议](https://developer.work.weixin.qq.com/document/path/101463)、[Raft External Agent](https://docs.raft.build/developers/sdk/external-agents/)。

## 日志与排错

| 事件 | 意义 |
| --- | --- |
| `raft_ready` | 身份、频道和执行 agent 检查通过 |
| `wecom_authenticated` | 企微长连接认证成功 |
| `wecom_group_discovered` | 可用于配置的群 ID |
| `wecom_received` / `raft_posted` | 收到企微消息 / Raft 已确认发送 |
| `raft_mention_delivery` | mention 投递状态；`pending` 尚未确认，`delivered` 已投递 |
| `wecom_forwarded` | 企微已确认收到一段回复 |
| `raft_send_failed` / `raft_poll_failed` | Raft 发送或读取错误 |
| `raft_follow_failed` | 线程关注失败，线程回复可能无法进入 inbox |
| `wecom_*_failed` / `wecom_error` | 企微回复或连接异常 |

缺少群 ID 时先运行发现流程。401/403 请检查凭据是否撤销、权限和频道成员身份；身份不匹配请核对 `RAFT_EXPECTED_AGENT`。企微认证失败时检查 Bot ID/Secret、API 长连接模式及是否还有第二个同 bot 进程。

日志保留消息关联 ID 和安全错误状态，不打印密钥、请求体或完整聊天内容。消息 ID 用于排错和幂等处理，不会添加到 Raft 正文。
