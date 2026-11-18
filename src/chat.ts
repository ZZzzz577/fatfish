import type { ConversationStore } from "./context";
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

    const wakeWord = findWakeWord(text, wakeWords);
    const quotedBot = storedQuote?.self === true;
    const shouldReply = incoming.addressed || quotedBot || wakeWord !== undefined;
    const trigger: "at" | "name" | "quote" = quotedBot
      ? "quote"
      : wakeWord !== undefined && !incoming.addressed
        ? "name"
        : "at";

    const commandText = stripWakeWords(text, wakeWords);

    if (shouldReply && isResetCommand(commandText)) {
      history.clear(incoming.key);
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
      mentioned: incoming.mentioned,
      timezone,
      trigger,
    });

    // 当前消息的图在前，引用消息的图在后，总共不超过 4 张
    const images = [...parsed.images, ...quotedImages].slice(0, 4);

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
