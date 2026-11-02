import { loadConfig } from './config.js';
import { hideSecrets, log, errorKind } from './log.js';
import { createWecom, conversationOf } from './wecom.js';
import { RaftConnection } from './raft.js';
import { Bridge } from './bridge.js';

async function main() {
  const mode = process.argv[2] || 'run';
  if (!['run', 'discover', 'check'].includes(mode)) throw new Error('命令仅支持 run / discover / check');
  const cfg = loadConfig(mode);
  hideSecrets([cfg.secret, cfg.credential]);
  const raft = mode === 'discover' ? undefined : new RaftConnection(cfg);
  if (raft) await raft.check();
  if (mode === 'check') return;
  const { client, port } = createWecom(cfg);
  const bridge = mode === 'run' ? new Bridge(cfg, raft!, port) : undefined;
  if (bridge) log('bridge_modes', { allowPrivate: cfg.allowPrivate, allowGroup: cfg.allowGroup });
  let stopping = false, timer: ReturnType<typeof setTimeout> | undefined;
  let polling: Promise<void> = Promise.resolve();
  const tick = () => {
    polling = (async () => {
      let more = false;
      try { more = await bridge!.poll(); }
      catch (error) { log('raft_poll_failed', { kind: errorKind(error) }); }
      if (!stopping) timer = setTimeout(tick, more ? 100 : cfg.pollMs);
    })();
  };
  client.on('message.text', frame => {
    if (stopping) return;
    if (mode === 'discover') {
      const m = frame.body;
      const conversation = conversationOf(frame);
      if (conversation && m?.aibotid === cfg.botId) log('wecom_conversation_discovered', {
        chatType: conversation.type, chatId: conversation.id, senderId: m.from.userid, messageId: m.msgid,
      });
    } else void bridge!.accept(frame).catch(error => log('message_failed', { kind: errorKind(error) }));
  });
  let initialized = false;
  client.on('authenticated', () => {
    if (bridge && !initialized) { initialized = true; tick(); }
    if (mode === 'discover') log('discover_ready', { instruction: '请私聊机器人，或在群里 @机器人 发一句话；本模式只记录会话信息，不转发任务。正常运行无需填写群 ID。' });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    stopping = true; clearTimeout(timer);
    const deadline = setTimeout(() => process.exit(1), 25_000); deadline.unref();
    void Promise.all([polling, bridge?.drain()]).finally(() => {
      client.disconnect(); clearTimeout(deadline); log('bridge_stopped');
    });
  });
  client.connect();
}
main().catch(error => { log('startup_failed', { message: error instanceof Error ? error.message : '启动失败' }); process.exitCode = 1; });
