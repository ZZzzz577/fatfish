import { Bot, ReceiverMode } from "qq-official-bot";
import type {
  GroupMessageEvent,
  GuildMessageEvent,
  PrivateMessageEvent,
} from "qq-official-bot";
import { generateReply } from "./src/agent";
import { ConversationStore } from "./src/context";
import type { Mention } from "./src/message";
import { cleanReply, parseRawMessage, splitReply } from "./src/message";
import { buildChatPrompt } from "./src/persona";
import type { ChatScene } from "./src/persona";

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

const history = new ConversationStore(historyLimit);

const bot = new Bot({
  appid,
  secret,
  mode: ReceiverMode.WEBSOCKET,
  removeAt: true,
  logLevel: "info",
  intents: ["GROUP_AND_C2C_EVENT", "PUBLIC_GUILD_MESSAGES"],
});

const FALLBACKS = [
  "咕噜……我刚刚走神了，你再说一遍？",
  "这条鱼卡了一下，等我摆个尾再来。",
  "抱歉，我这会儿有点转不动，稍后再试？",
];

function pickFallback(): string {
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)] ?? "我这边出了点问题，稍后再试？";
}

/** 同一条消息可能同时触发多个事件，用 message_id 去重 */
const seenMessageIds = new Set<string>();

function alreadyHandled(messageId: string): boolean {
  if (!messageId) return false;
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.add(messageId);
  if (seenMessageIds.size > 1000) {
    const oldest = seenMessageIds.values().next().value;
    if (oldest !== undefined) seenMessageIds.delete(oldest);
  }
  return false;
}

/** 同一个群/私聊内串行处理，保证回复顺序和上下文顺序一致 */
const queues = new Map<string, Promise<void>>();

function enqueue(key: string, task: () => Promise<void>): void {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous
    .then(task, task)
    .catch((err) => console.error(`[${key}] 处理消息失败:`, err));
  queues.set(key, next);
  void next.finally(() => {
    if (queues.get(key) === next) queues.delete(key);
  });
}

const HELP_TEXT =
  "我是大肥鱼，群里的 AI 鱼。@ 我随便聊就行；想让我忘掉刚才的对话，说「重置对话」。";

function isResetCommand(text: string): boolean {
  return /^(\/reset|重置对话|清空记忆|忘掉刚才)$/i.test(text.trim());
}

function isHelpCommand(text: string): boolean {
  return /^(\/help|help|帮助)$/i.test(text.trim());
}

interface IncomingMessage {
  key: string;
  scene: ChatScene;
  messageId: string;
  userId: string;
  userName: string;
  raw: string;
  mentions: readonly Mention[];
  reply: (text: string) => Promise<unknown>;
}

async function handleMessage(incoming: IncomingMessage): Promise<void> {
  if (alreadyHandled(incoming.messageId)) return;

  const parsed = parseRawMessage(incoming.raw, incoming.mentions);
  const text = parsed.text.trim();

  // 纯空消息（比如只 @ 了一下）给个回应，别装死
  if (!text && parsed.images.length === 0 && !parsed.quoteId) {
    await incoming.reply("咕噜？叫我干嘛。");
    return;
  }

  if (isResetCommand(text)) {
    history.clear(incoming.key);
    await incoming.reply("好，刚才聊的我全忘了，重新开始。");
    return;
  }

  if (isHelpCommand(text)) {
    await incoming.reply(HELP_TEXT);
    return;
  }

  const quote = parsed.quoteId ? history.find(incoming.key, parsed.quoteId) : undefined;
  const transcript = [...history.recent(incoming.key)];

  history.add(incoming.key, {
    id: incoming.messageId,
    userId: incoming.userId,
    userName: incoming.userName,
    text: text || "【图片】",
    timestamp: Date.now(),
    self: false,
  });

  const prompt = buildChatPrompt({
    scene: incoming.scene,
    transcript,
    quote,
    sender: incoming.userName || "群友",
    text,
    imageCount: parsed.images.length,
    timezone,
  });

  const answer = cleanReply(await generateReply({ prompt, images: parsed.images })) || pickFallback();
  const chunks = splitReply(answer, maxReplyChars);
  let replyId: string | undefined;

  for (const [index, chunk] of chunks.entries()) {
    try {
      const sent = await incoming.reply(chunk);
      if (!replyId) replyId = sentId(sent);
    } catch (err) {
      console.error("发送回复失败:", err);
      break;
    }
    if (index < chunks.length - 1) await Bun.sleep(250);
  }

  history.add(incoming.key, {
    id: replyId ?? `${incoming.messageId}:reply`,
    userId: "bot",
    userName: "大肥鱼",
    text: answer,
    timestamp: Date.now(),
    self: true,
  });
}

/** 从发送结果里取平台消息 id，方便别人引用机器人的话时能回溯 */
function sentId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

async function safeReply(reply: () => Promise<unknown>): Promise<void> {
  try {
    await reply();
  } catch (err) {
    console.error("发送消息失败:", err);
  }
}

function handleGroup(event: GroupMessageEvent): void {
  const key = `group:${event.group_id}`;
  enqueue(key, async () => {
    try {
      await handleMessage({
        key,
        scene: { kind: "group", name: event.group_name },
        messageId: event.message_id,
        userId: event.sender.user_id,
        userName: event.sender.user_name,
        raw: event.raw_message,
        mentions: (event.mentions ?? []).map((mention) => ({
          id: mention.id,
          name: mention.username,
        })),
        reply: (text) => event.reply(text),
      });
    } catch (err) {
      console.error("处理群消息失败:", err);
      await safeReply(() => event.reply(pickFallback()));
    }
  });
}

function handlePrivate(event: PrivateMessageEvent): void {
  const key = `private:${event.user_id}`;
  enqueue(key, async () => {
    try {
      await handleMessage({
        key,
        scene: { kind: "private" },
        messageId: event.message_id,
        userId: event.sender.user_id,
        userName: event.sender.user_name,
        raw: event.raw_message,
        mentions: [],
        reply: (text) => event.reply(text),
      });
    } catch (err) {
      console.error("处理私聊消息失败:", err);
      await safeReply(() => event.reply(pickFallback()));
    }
  });
}

function handleGuild(event: GuildMessageEvent): void {
  const key = `guild:${event.guild_id}:${event.channel_id}`;
  enqueue(key, async () => {
    try {
      await handleMessage({
        key,
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
        reply: (text) => event.reply(text),
      });
    } catch (err) {
      console.error("处理频道消息失败:", err);
      await safeReply(() => event.reply(pickFallback()));
    }
  });
}

bot.on("message.group", handleGroup);
bot.on("message.private", handlePrivate);
bot.on("message.guild", handleGuild);

bot.on("error", (err) => {
  console.error("机器人错误:", err);
});

await bot.start();
console.log(`机器人已启动（时区 ${timezone}，记忆 ${historyLimit} 条，单条上限 ${maxReplyChars} 字）`);

const shutdown = async () => {
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
