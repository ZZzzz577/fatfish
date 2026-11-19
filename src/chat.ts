import type { ConversationStore, StoredMessage } from "./context";
import {
  cleanReply,
  findWakeWord,
  parseRawMessage,
  splitReply,
  stripWakeWords,
} from "./message";
import type { Mention, QuotedContent } from "./message";
import { buildChatPrompt } from "./persona";
import type { ChatScene } from "./persona";

const DEFAULT_FALLBACKS = [
  "咕噜……我刚刚走神了，你再说一遍？",
  "这条鱼卡了一下，等我摆个尾再来。",
  "抱歉，我这会儿有点转不动，稍后再试？",
];

export interface IncomingMessage {
  key: string;
  scene: ChatScene;
  messageId: string;
  userId: string;
  userName: string;
  raw: string;
  mentions: readonly Mention[];
  /** 这条消息是否直接叫到了它（@、引用它的话） */
  addressed: boolean;
  /** 平台随消息推过来的被引用内容（message_type=103 时） */
  quoted?: QuotedContent;
  /** 这条消息 @ 了谁（不含机器人自己） */
  mentioned?: readonly string[];
  reply: (text: string) => Promise<unknown>;
}

export interface ChatHandlerOptions {
  history: ConversationStore;
  generate: (input: { prompt: string; images: readonly string[] }) => Promise<string>;
  wakeWords: readonly string[];
  maxReplyChars: number;
  timezone: string;
  fallbacks?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  /** 被叫到之后的对话窗口时长，窗口内的提问会当作在问它；0 表示关闭 */
  followUpMs?: number;
  now?: () => number;
}

/** 从发送结果里取平台消息 id，方便别人引用机器人的话时能回溯 */
function sentId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "id" in value) {
    const id = (value as { id: unknown }).id;
    if (typeof id === "string" && id) return id;
  }
  return undefined;
}

export function createChatHandler(options: ChatHandlerOptions) {
  const { history, generate, wakeWords, maxReplyChars, timezone } = options;
  const fallbacks = options.fallbacks ?? DEFAULT_FALLBACKS;
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  const followUpMs = options.followUpMs ?? 90_000;
  const now = options.now ?? Date.now;

  // 每个群/私聊最近一次“它在对话”的时间，用于判断没点名的追问
  const activeUntil = new Map<string, number>();

  const seenMessageIds = new Set<string>();
  const queues = new Map<string, Promise<void>>();

  function fallback(): string {
    return fallbacks[Math.floor(Math.random() * fallbacks.length)] ?? "我这边出了点问题，稍后再试？";
  }

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

  async function safeReply(incoming: IncomingMessage, text: string): Promise<void> {
    try {
      await incoming.reply(text);
    } catch (err) {
      console.error("发送消息失败:", err);
    }
  }

  async function processMessage(incoming: IncomingMessage): Promise<void> {
    if (alreadyHandled(incoming.messageId)) return;

    const parsed = parseRawMessage(incoming.raw, incoming.mentions);
    const text = parsed.text.trim();
    const storedQuote = parsed.quoteId ? history.find(incoming.key, parsed.quoteId) : undefined;
    const quotedImages = incoming.quoted?.images ?? [];
    const quote =
      storedQuote ?? (incoming.quoted?.text ? { text: incoming.quoted.text } : undefined);
    const transcript = [...history.recent(incoming.key)];

    // 图片单独发、下一句才 @ 它问“这图啥意思”时，把最近那张图也带上
    const recentImages =
      parsed.images.length === 0 && quotedImages.length === 0
        ? collectRecentImages(transcript, 5 * 60_000, 1)
        : [];

    const wakeWord = findWakeWord(text, wakeWords);
    const quotedBot = storedQuote?.self === true;
    const currentTime = now();
    const inFollowUpWindow = currentTime < (activeUntil.get(incoming.key) ?? 0);
    const followUp =
      !incoming.addressed &&
      !quotedBot &&
      wakeWord === undefined &&
      inFollowUpWindow &&
      (incoming.mentioned?.length ?? 0) === 0 &&
      !(storedQuote && !storedQuote.self) &&
      looksLikeQuestion(text);

    const shouldReply = incoming.addressed || quotedBot || wakeWord !== undefined || followUp;
    const trigger: "at" | "name" | "quote" | "followup" = quotedBot
      ? "quote"
      : wakeWord !== undefined && !incoming.addressed
        ? "name"
        : followUp
          ? "followup"
          : "at";

    if (shouldReply) activeUntil.set(incoming.key, currentTime + followUpMs);

    const commandText = stripWakeWords(text, wakeWords);

    if (shouldReply && isResetCommand(commandText)) {
      history.clear(incoming.key);
      activeUntil.delete(incoming.key);
      await safeReply(incoming, "好，刚才聊的我全忘了，重新开始。");
      return;
    }

    if (shouldReply && isHelpCommand(commandText)) {
      await safeReply(incoming, HELP_TEXT);
      return;
    }

    // 纯空消息（比如只 @ 了一下）给个回应，别装死
    if (
      !text &&
      parsed.images.length === 0 &&
      !parsed.quoteId &&
      !incoming.quoted?.text &&
      quotedImages.length === 0
    ) {
      if (shouldReply) await safeReply(incoming, "咕噜？叫我干嘛。");
      return;
    }

    // 不管回不回，先把消息记进上下文，之后接话才接得上
    history.add(incoming.key, {
      id: incoming.messageId,
      userId: incoming.userId,
      userName: incoming.userName,
      text: text || "【图片】",
      images: parsed.images.length > 0 ? [...parsed.images] : undefined,
      timestamp: Date.now(),
      self: false,
    });

    // 没叫到它：只当听众，不插嘴
    if (!shouldReply) return;

    const prompt = buildChatPrompt({
      scene: incoming.scene,
      transcript,
      quote,
      quotedImages: quotedImages.length,
      sender: incoming.userName || "群友",
      text,
      imageCount: parsed.images.length,
      recentImages: recentImages.length,
      mentioned: incoming.mentioned,
      timezone,
      trigger,
    });

    // 当前消息的图在前，引用消息的图其次，最近聊天的图最后，总共不超过 4 张
    const images = [...new Set([...parsed.images, ...quotedImages, ...recentImages])].slice(0, 4);
    if (images.length > 0) {
      console.log(
        `图片输入：当前 ${parsed.images.length}，引用 ${quotedImages.length}，最近 ${recentImages.length}`,
      );
    }

    let answer: string;
    try {
      answer = cleanReply(await generate({ prompt, images })) || fallback();
    } catch (err) {
      console.error("生成回复失败:", err);
      answer = fallback();
    }

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
      if (index < chunks.length - 1) await sleep(250);
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

  return {
    fallback,
    /** 直接处理一条消息，主要给测试用 */
    handle: processMessage,
    /** 同一个群/私聊内串行处理，保证回复顺序和上下文顺序一致 */
    enqueue(incoming: IncomingMessage): void {
      const previous = queues.get(incoming.key) ?? Promise.resolve();
      const next = previous
        .then(
          () => processMessage(incoming),
          () => processMessage(incoming),
        )
        .catch((err) => console.error(`[${incoming.key}] 处理消息失败:`, err));
      queues.set(incoming.key, next);
      void next.finally(() => {
        if (queues.get(incoming.key) === next) queues.delete(incoming.key);
      });
    },
  };
}

const HELP_TEXT =
  "我是大肥鱼，群里的 AI 鱼。@ 我或者直接喊「大肥鱼」都行；想让我忘掉刚才的对话，说「重置对话」。";

function isResetCommand(text: string): boolean {
  return /^(\/reset|重置对话|清空记忆|忘掉刚才)$/i.test(text.trim());
}

function isHelpCommand(text: string): boolean {
  return /^(\/help|help|帮助)$/i.test(text.trim());
}

/** 从最近聊天里捞图片，只取时间窗内的，最多 limit 张 */
function collectRecentImages(
  transcript: readonly StoredMessage[],
  maxAgeMs: number,
  limit: number,
): string[] {
  const cutoff = Date.now() - maxAgeMs;
  const images: string[] = [];
  for (let i = transcript.length - 1; i >= 0 && images.length < limit; i -= 1) {
    const message = transcript[i];
    if (!message || message.self || message.timestamp < cutoff) continue;
    for (const url of message.images ?? []) {
      if (!images.includes(url)) images.push(url);
      if (images.length >= limit) break;
    }
  }
  return images;
}

/** 粗略判断一条消息像不像在问问题/跟人说话，用来识别没点名的追问 */
export function looksLikeQuestion(text: string): boolean {
  const value = text.trim();
  if (!value) return false;
  if (/[?？]\s*$/.test(value)) return true;
  if (/^(你|您|大肥鱼|肥鱼)/.test(value)) return true;
  return /(吗|呢|怎么|什么|为什么|为啥|咋|哪|谁|多少|如何|能不能|可不可以|是不是|要不要|好不好|行不行|对不对|有没有|会不会|在吗)/.test(
    value,
  );
}
