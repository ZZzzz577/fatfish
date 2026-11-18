export interface StoredMessage {
  /** 平台消息 id，用于被引用消息的回溯 */
  id: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: number;
  /** 是否为机器人自己说的话 */
  self: boolean;
}

const MAX_CONVERSATIONS = 500;

/**
 * 进程内的短期会话记忆：每个群/私聊保留最近 N 条。
 * 没有落盘，重启即清空——对群聊来说这通常刚好够用。
 */
export class ConversationStore {
  private readonly conversations = new Map<string, StoredMessage[]>();

  constructor(private readonly limit: number = 20) {}

  add(key: string, message: StoredMessage): void {
    if (!this.conversations.has(key) && this.conversations.size >= MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value;
      if (oldest !== undefined) this.conversations.delete(oldest);
    }

    const list = this.conversations.get(key) ?? [];
    list.push(message);
    if (list.length > this.limit) {
      list.splice(0, list.length - this.limit);
    }
    this.conversations.set(key, list);
  }

  recent(key: string): readonly StoredMessage[] {
    return this.conversations.get(key) ?? [];
  }

  find(key: string, id: string): StoredMessage | undefined {
    const list = this.conversations.get(key);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i];
      if (message?.id === id) return message;
    }
    return undefined;
  }

  clear(key: string): void {
    this.conversations.delete(key);
  }

  get size(): number {
    return this.conversations.size;
  }
}
