import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { StoredMessage } from "./context";

interface MessageRow {
  id: string;
  user_id: string;
  user_name: string;
  text: string;
  images: string | null;
  timestamp: number;
  self: number;
}

const DEFAULT_PATH = "data/history.sqlite";
const DEFAULT_KEEP = 500;

/**
 * 聊天记录落盘。平台不提供群历史消息接口，所以只能把自己收到的消息存下来，
 * 重启后靠它把最近的上下文恢复回内存。
 */
export class HistoryStore {
  private readonly db: Database;
  private readonly keep: number;
  private readonly insert;
  private readonly prune;
  private readonly recentStmt;
  private readonly conversationStmt;
  private readonly searchStmt;
  private readonly clearStmt;

  constructor(
    path: string = Bun.env.HISTORY_DB || DEFAULT_PATH,
    keep: number = positiveInt(Bun.env.HISTORY_KEEP, DEFAULT_KEEP),
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }

    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL;");
    this.db.run("PRAGMA synchronous = NORMAL;");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        conversation TEXT NOT NULL,
        id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        text TEXT NOT NULL,
        images TEXT,
        timestamp INTEGER NOT NULL,
        self INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (conversation, id)
      );
    `);
    this.db.run(
      "CREATE INDEX IF NOT EXISTS idx_messages_conversation_time ON messages (conversation, timestamp);",
    );

    this.keep = keep;
    this.insert = this.db.query(`
      INSERT OR IGNORE INTO messages (conversation, id, user_id, user_name, text, images, timestamp, self)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    `);
    this.prune = this.db.query(`
      DELETE FROM messages
      WHERE conversation = ?1
        AND rowid NOT IN (
          SELECT rowid FROM messages WHERE conversation = ?1 ORDER BY timestamp DESC, rowid DESC LIMIT ?2
        )
    `);
    this.recentStmt = this.db.query(`
      SELECT id, user_id, user_name, text, images, timestamp, self
      FROM messages WHERE conversation = ?1
      ORDER BY timestamp DESC, rowid DESC LIMIT ?2
    `);
    this.conversationStmt = this.db.query(`
      SELECT conversation, MAX(timestamp) AS last FROM messages
      GROUP BY conversation ORDER BY last DESC LIMIT ?1
    `);
    this.searchStmt = this.db.query(`
      SELECT id, user_id, user_name, text, images, timestamp, self
      FROM messages
      WHERE conversation = ?1 AND text LIKE ?2 ESCAPE '\\'
      ORDER BY timestamp DESC, rowid DESC LIMIT ?3
    `);
    this.clearStmt = this.db.query("DELETE FROM messages WHERE conversation = ?1");
  }

  append(conversation: string, message: StoredMessage): void {
    this.insert.run(
      conversation,
      message.id,
      message.userId,
      message.userName,
      message.text,
      message.images && message.images.length > 0 ? JSON.stringify(message.images) : null,
      message.timestamp,
      message.self ? 1 : 0,
    );
    this.prune.run(conversation, this.keep);
  }

  /** 按时间正序返回最近 limit 条 */
  recent(conversation: string, limit: number): StoredMessage[] {
    const rows = this.recentStmt.all(conversation, limit) as MessageRow[];
    return rows.reverse().map(toStoredMessage);
  }

  /** 最近活跃的会话，用于启动时恢复上下文 */
  conversations(limit = 500): string[] {
    const rows = this.conversationStmt.all(limit) as { conversation: string }[];
    return rows.map((row) => row.conversation);
  }

  /** 关键字搜索更早的聊天记录 */
  search(conversation: string, query: string, limit = 20): StoredMessage[] {
    const escaped = query.replace(/[\\%_]/g, (char) => `\\${char}`);
    const rows = this.searchStmt.all(conversation, `%${escaped}%`, limit) as MessageRow[];
    return rows.map(toStoredMessage);
  }

  clear(conversation: string): void {
    this.clearStmt.run(conversation);
  }

  close(): void {
    this.db.close();
  }
}

function toStoredMessage(row: MessageRow): StoredMessage {
  let images: string[] | undefined;
  if (row.images) {
    try {
      const parsed: unknown = JSON.parse(row.images);
      if (Array.isArray(parsed)) {
        images = parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      images = undefined;
    }
  }

  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    text: row.text,
    images: images && images.length > 0 ? images : undefined,
    timestamp: row.timestamp,
    self: row.self === 1,
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
