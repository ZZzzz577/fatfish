import { Bot, ReceiverMode } from "qq-official-bot";
import type {
  GroupMessageEvent,
  GuildMessageEvent,
  PrivateMessageEvent,
} from "qq-official-bot";
import { generateReply } from "./src/agent";
import { createChatHandler } from "./src/chat";
import { ConversationStore } from "./src/context";
import { extractQuotedContent } from "./src/message";

const appid = Bun.env.APP_ID;
const secret = Bun.env.APP_SECRET;

if (!appid || !secret) {
  console.error("缺少环境变量: 请在 .env 中配置 APP_ID 和 APP_SECRET");
  process.exit(1);
}

const DEFAULT_TIMEZONE = "Asia/Shanghai";

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveTimezone(value: string | undefined): string {
  const candidate = value?.trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: candidate });
    return candidate;
  } catch {
    console.warn(`无效的 TIMEZONE「${candidate}」，改用 ${DEFAULT_TIMEZONE}`);
    return DEFAULT_TIMEZONE;
  }
}

const timezone = resolveTimezone(Bun.env.TIMEZONE);
const historyLimit = positiveInt(Bun.env.HISTORY_LIMIT, 20);
const maxReplyChars = positiveInt(Bun.env.REPLY_MAX_CHARS, 600);
const followUpMs = positiveInt(Bun.env.FOLLOW_UP_MS, 90_000);

const DEFAULT_WAKE_WORDS = "大肥鱼,肥鱼,胖鱼,肥鱼鱼,fatfish";
const wakeWords = (Bun.env.WAKE_WORDS ?? DEFAULT_WAKE_WORDS)
  .split(",")
  .map((word) => word.trim())
  .filter(Boolean);

const chat = createChatHandler({
  history: new ConversationStore(historyLimit),
  generate: generateReply,
  wakeWords,
  maxReplyChars,
  timezone,
  followUpMs,
});

const bot = new Bot({
  appid,
  secret,
  mode: ReceiverMode.WEBSOCKET,
  removeAt: true,
  logLevel: "info",
  intents: ["GROUP_AND_C2C_EVENT", "PUBLIC_GUILD_MESSAGES"],
});

interface RawMention {
  username?: unknown;
  is_you?: unknown;
}

/** 取出这条消息 @ 了谁，去掉机器人自己，去重 */
function mentionedNames(mentions: unknown): string[] {
  if (!Array.isArray(mentions)) return [];
  const names: string[] = [];
  for (const item of mentions) {
    if (!item || typeof item !== "object") continue;
    const mention = item as RawMention;
    if (mention.is_you === true) continue;
    if (typeof mention.username === "string" && mention.username.trim()) {
      names.push(mention.username.trim());
    }
  }
  return [...new Set(names)];
}

/**
 * 引用回复时平台会把被引用的消息放在 msg_elements 里，
 * SDK 没有解析这个字段，这里从原始 payload 取出来。
 */
function quotedOf(event: GroupMessageEvent | PrivateMessageEvent | GuildMessageEvent) {
  const payload = event as unknown as { message_type?: unknown; msg_elements?: unknown };
  if (Number(payload.message_type ?? 0) !== 103) return undefined;
  return extractQuotedContent(payload.msg_elements);
}

function handleGroup(event: GroupMessageEvent): void {
  const mentions = event.mentions ?? [];
  const addressed = event.sub_type === "at" || mentions.some((mention) => mention.is_you);

  chat.enqueue({
    key: `group:${event.group_id}`,
    scene: { kind: "group", name: event.group_name },
    messageId: event.message_id,
    userId: event.sender.user_id,
    userName: event.sender.user_name,
    raw: event.raw_message,
    mentions: mentions.map((mention) => ({
      id: mention.id,
      memberId: mention.member_openid,
      name: mention.username,
    })),
    addressed,
    quoted: quotedOf(event),
    mentioned: mentionedNames(mentions),
    reply: (text) => event.reply(text),
  });
}

function handlePrivate(event: PrivateMessageEvent): void {
  chat.enqueue({
    key: `private:${event.user_id}`,
    scene: { kind: "private" },
    messageId: event.message_id,
    userId: event.sender.user_id,
    userName: event.sender.user_name,
    raw: event.raw_message,
    mentions: [],
    addressed: true,
    quoted: quotedOf(event),
    mentioned: mentionedNames((event as unknown as { mentions?: unknown }).mentions),
    reply: (text) => event.reply(text),
  });
}

function handleGuild(event: GuildMessageEvent): void {
  chat.enqueue({
    key: `guild:${event.guild_id}:${event.channel_id}`,
    scene: {
      kind: "guild",
      name: event.guild_name,
      channelName: event.channel_name,
    },
    messageId: event.message_id,
    userId: event.sender.user_id,
    userName: event.sender.user_name,
    raw: event.raw_message,
    mentions: [],
    addressed: true,
    quoted: quotedOf(event),
    mentioned: mentionedNames((event as unknown as { mentions?: unknown }).mentions),
    reply: (text) => event.reply(text),
  });
}

bot.on("message.group", handleGroup);
bot.on("message.private", handlePrivate);
bot.on("message.guild", handleGuild);

bot.on("error", (err) => {
  console.error("机器人错误:", err);
});

await bot.start();
console.log(
  `机器人已启动（时区 ${timezone}，记忆 ${historyLimit} 条，单条上限 ${maxReplyChars} 字，唤醒词 ${wakeWords.join("/") || "无"}，追问窗口 ${Math.round(followUpMs / 1000)}s）`,
);

const shutdown = async () => {
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
