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
  private retired: PrivateSession[] = [];
  private resetSourceIds = new Set<string>();
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
      if (![1, 2].includes(data.version) || data.scope !== scope || !Array.isArray(data.sessions)) throw new Error();
      const retired = data.version === 2 ? data.retiredSessions : [];
      const resets = data.version === 2 ? data.resetSourceIds : [];
      if (!Array.isArray(retired) || !Array.isArray(resets) || retired.length > 1000 || resets.length > 1000
        || !resets.every(id => typeof id === 'string' && id.trim())) throw new Error();
      const roots = new Set<string>();
      for (const [index, row] of [...data.sessions, ...retired].entries()) {
        const active = index < data.sessions.length;
        if (!row || ![row.userId, row.rootMessageId, row.firstSourceId].every(v => typeof v === 'string' && v.trim())
          || (active && store.sessions.has(row.userId)) || roots.has(row.rootMessageId)) throw new Error();
        const session = { userId: row.userId, rootMessageId: row.rootMessageId, firstSourceId: row.firstSourceId };
        if (active) store.sessions.set(row.userId, session);
        else store.retired.push(session);
        roots.add(row.rootMessageId);
      }
      store.resetSourceIds = new Set(resets);
    } catch { throw new Error('私聊会话映射文件无效；已保留原文件，请检查后再启动'); }
    return store;
  }

  get(userId: string): PrivateSession | undefined {
    const session = this.sessions.get(userId);
    return session ? { ...session } : undefined;
  }
  all(): PrivateSession[] { return [...this.sessions.values()].map(session => ({ ...session })); }
  routes(): PrivateSession[] { return [...this.all(), ...this.retired.map(session => ({ ...session }))]; }
  hasFirstSource(sourceId: string) { return this.routes().some(session => session.firstSourceId === sourceId); }
  hasReset(sourceId: string) { return this.resetSourceIds.has(sourceId); }

  // Commit the switch before acknowledging it. A disk failure must leave the old topic active.
  async reset(userId: string, sourceId: string) {
    await this.flush();
    if (this.hasReset(sourceId)) return;
    const previous = this.sessions.get(userId), retired = this.retired, resets = this.resetSourceIds;
    this.sessions.delete(userId);
    this.retired = [...retired, ...(previous ? [previous] : [])].slice(-1000);
    this.resetSourceIds = new Set([...resets, sourceId].slice(-1000));
    this.dirty = true;
    try { await this.flush(); }
    catch (error) {
      if (previous) this.sessions.set(userId, previous);
      this.retired = retired; this.resetSourceIds = resets; this.dirty = false;
      throw error;
    }
  }

  remember(session: PrivateSession) {
    const existing = this.sessions.get(session.userId);
    if (existing) {
      if (existing.rootMessageId !== session.rootMessageId || existing.firstSourceId !== session.firstSourceId) {
        throw new Error('私聊会话映射冲突');
      }
      return;
    }
    if (this.routes().some(row => row.rootMessageId === session.rootMessageId)) throw new Error('私聊线程已绑定其他会话');
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
        await writeFile(temporary, JSON.stringify({ version: 2, scope: this.scope, sessions: this.all(),
          retiredSessions: this.retired, resetSourceIds: [...this.resetSourceIds] }) + '\n',
          { encoding: 'utf8', mode: 0o600, flush: true });
        await rename(temporary, this.file);
      } catch { throw new Error('无法保存私聊会话映射文件'); }
    }
    this.dirty = false;
  }
}
