import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Config } from './config.js';

export interface PrivateSession {
  userId: string;
  rootMessageId: string;
  firstSourceId: string;
}

// Only routing identities live here. Raft owns the conversation history.
export class PrivateSessions {
  private sessions = new Map<string, PrivateSession>();
  private dirty = false;
  constructor(readonly file?: string, private readonly scope = '') {}

  static async load(cfg: Config, directory = resolve('.local/private-sessions')) {
    const scope = createHash('sha256').update(JSON.stringify([
      cfg.botId, cfg.serverUrl.replace(/\/+$/, ''), cfg.channel, cfg.expectedAgent, cfg.targetAgent,
    ])).digest('hex');
    const store = new PrivateSessions(join(directory, `${scope}.json`), scope);
    let source: string;
    try { source = await readFile(store.file!, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return store;
      throw new Error('无法读取私聊会话映射文件');
    }
    try {
      const data = JSON.parse(source);
      if (data.version !== 1 || data.scope !== scope || !Array.isArray(data.sessions)) throw new Error();
      const roots = new Set<string>();
      for (const row of data.sessions) {
        if (!row || ![row.userId, row.rootMessageId, row.firstSourceId].every(v => typeof v === 'string' && v.trim())
          || store.sessions.has(row.userId) || roots.has(row.rootMessageId)) throw new Error();
        store.sessions.set(row.userId, { userId: row.userId, rootMessageId: row.rootMessageId, firstSourceId: row.firstSourceId });
        roots.add(row.rootMessageId);
      }
    } catch { throw new Error('私聊会话映射文件无效；已保留原文件，请检查后再启动'); }
    return store;
  }

  get(userId: string): PrivateSession | undefined {
    const session = this.sessions.get(userId);
    return session ? { ...session } : undefined;
  }
  all(): PrivateSession[] { return [...this.sessions.values()].map(session => ({ ...session })); }

  remember(session: PrivateSession) {
    const existing = this.sessions.get(session.userId);
    if (existing) {
      if (existing.rootMessageId !== session.rootMessageId || existing.firstSourceId !== session.firstSourceId) {
        throw new Error('私聊会话映射冲突');
      }
      return;
    }
    if (this.all().some(row => row.rootMessageId === session.rootMessageId)) throw new Error('私聊线程已绑定其他用户');
    this.sessions.set(session.userId, { ...session });
    this.dirty = true;
  }

  // The bridge calls this on its serial queue; a failed write stays dirty for retry.
  async flush() {
    if (!this.dirty) return;
    if (this.file) {
      try {
        await mkdir(dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, JSON.stringify({ version: 1, scope: this.scope, sessions: this.all() }) + '\n',
          { encoding: 'utf8', mode: 0o600, flush: true });
        await rename(temporary, this.file);
      } catch { throw new Error('无法保存私聊会话映射文件'); }
    }
    this.dirty = false;
  }
}
