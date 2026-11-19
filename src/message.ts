const TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9]*)(?:,([^<>]*))?>/g;

const PLACEHOLDERS: Record<string, string> = {
  image: "【图片】",
  mface: "【表情】",
  face: "【表情】",
  video: "【视频】",
  audio: "【语音】",
  file: "【文件】",
  ark: "【卡片】",
  embed: "【卡片】",
  markdown: "【卡片】",
  json: "【卡片】",
  xml: "【卡片】",
};

const MAX_IMAGES = 4;

export interface Mention {
  /** 用户 openid */
  id: string;
  /** 群成员 openid，全量消息里 @ 用的是这个 */
  memberId?: string;
  name: string;
}

export interface ParsedMessage {
  /** 把 CQ 风格的标签换成可读文本后的消息内容 */
  text: string;
  /** 消息附带的图片地址，最多 4 张 */
  images: string[];
  /** 被引用消息的 id */
  quoteId?: string;
}

function parseAttrs(raw: string | undefined): Record<string, string> {
  const attrs: Record<string, string> = {};
  if (!raw) return attrs;
  for (const part of raw.split(",")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim().toLowerCase();
    const value = part.slice(index + 1).trim();
    if (key) attrs[key] = value;
  }
  return attrs;
}

/**
 * 把 qq-official-bot 的 raw_message 拆成“能读的文字 + 图片列表 + 引用 id”。
 * raw_message 里图片、表情、引用都是 <image,url=...> 这样的标签，直接喂给模型会很怪。
 */
export function parseRawMessage(raw: string, mentions: readonly Mention[] = []): ParsedMessage {
  // 全量模式下 @ 是 <@member_openid> / <@all> 这种 Python 风味写法，先统一成 <at,...>
  const normalized = raw
    .replace(/<@all>/gi, "<at,user_id=all>")
    .replace(/<@!?([A-Za-z0-9_-]+)>/g, "<at,user_id=$1>");

  const images: string[] = [];
  let quoteId: string | undefined;
  let text = "";
  let cursor = 0;

  for (const match of normalized.matchAll(TAG_PATTERN)) {
    const [full, rawType = "", rawAttrs] = match;
    const index = match.index ?? 0;
    text += normalized.slice(cursor, index);
    cursor = index + full.length;

    const type = rawType.toLowerCase();
    const attrs = parseAttrs(rawAttrs);

    if (type === "reply") {
      quoteId = attrs.id || attrs.message_id || undefined;
      continue;
    }

    if (type === "at") {
      const userId = attrs.user_id ?? attrs.id ?? "";
      if (userId === "all") {
        text += "@全体成员";
      } else {
        const name =
          mentions.find((mention) => mention.id === userId || mention.memberId === userId)?.name ??
          attrs.username;
        text += `@${name ?? "某人"}`;
      }
      continue;
    }

    const placeholder = PLACEHOLDERS[type];
    if (placeholder) {
      text += placeholder;
      if (type === "image") {
        const url = attrs.url ?? "";
        if (/^https?:\/\//i.test(url) && images.length < MAX_IMAGES && !images.includes(url)) {
          images.push(url);
        }
      }
      continue;
    }

    // 不认识的标签原样保留，避免把用户内容吃掉
    text += full;
  }

  text += normalized.slice(cursor);
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return { text, images, quoteId };
}

const MAX_QUOTED_CHARS = 800;

export interface QuotedContent {
  text: string;
  images: string[];
}

/**
 * 引用回复时平台会把被引用的消息塞进 msg_elements，
 * 这里取出文字和图片，供模型理解“他引用的到底是什么”。
 */
export function extractQuotedContent(elements: unknown): QuotedContent | undefined {
  if (!Array.isArray(elements)) return undefined;

  const parts: string[] = [];
  const images: string[] = [];

  for (const element of elements) {
    if (!element || typeof element !== "object") continue;

    const content = (element as { content?: unknown }).content;
    if (typeof content === "string" && content.trim()) {
      parts.push(parseRawMessage(content).text);
    }

    const attachments = (element as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) continue;

    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== "object") continue;
      const url = (attachment as { url?: unknown }).url;
      const type = String((attachment as { content_type?: unknown }).content_type ?? "");
      const filename = String((attachment as { filename?: unknown }).filename ?? "");

      if (typeof url === "string" && /^https?:\/\//i.test(url) && type.startsWith("image/")) {
        if (images.length < MAX_IMAGES && !images.includes(url)) images.push(url);
      } else if (filename) {
        parts.push(`【文件】${filename}`);
      } else if (type === "voice") {
        parts.push("【语音】");
      } else if (type.startsWith("video/")) {
        parts.push("【视频】");
      }
    }
  }

  const text = parts.join("\n").trim().slice(0, MAX_QUOTED_CHARS);
  if (!text && images.length === 0) return undefined;
  return { text, images };
}

/** 把模型输出整理成适合 QQ 发送的纯文本 */
export function cleanReply(input: string): string {
  return input
    .replace(/```[^\n]*\n?/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1（$2）")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 消息里有没有叫到它的名字，返回命中的那个词 */
export function findWakeWord(text: string, words: readonly string[]): string | undefined {
  const haystack = text.toLowerCase();
  return words.find((word) => word.length > 0 && haystack.includes(word.toLowerCase()));
}

/** 去掉消息里的称呼，方便识别“大肥鱼，重置对话”这类指令 */
export function stripWakeWords(text: string, words: readonly string[]): string {
  const valid = [...words]
    .filter((word) => word.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  if (valid.length === 0) return text.trim();
  const pattern = new RegExp(valid.join("|"), "gi");
  return text
    .replace(pattern, "")
    .replace(/^[\s,，.。!！?？:：、~～-]+/, "")
    .trim();
}

const MAX_CHUNKS = 4;

/** QQ 单条消息有长度上限，超长内容按句号/换行切开，最多发 4 条 */
export function splitReply(input: string, maxLength = 600): string[] {
  const text = input.trim();
  if (!text) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > maxLength) {
    const window = rest.slice(0, maxLength);
    const candidates = ["\n", "。", "！", "？", "；", "…", "~", "～"]
      .map((token) => window.lastIndexOf(token))
      .filter((index) => index > maxLength * 0.5);
    const cut = candidates.length > 0 ? Math.max(...candidates) + 1 : maxLength;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) chunks.push(rest);

  if (chunks.length > MAX_CHUNKS) {
    // 实在写太长就截断，避免一条回复刷屏；保留 4 条以内且每条都不超限
    const kept = chunks.slice(0, MAX_CHUNKS);
    const last = kept[MAX_CHUNKS - 1] ?? "";
    kept[MAX_CHUNKS - 1] = `${last.slice(0, Math.max(0, maxLength - 1))}…`;
    return kept;
  }

  return chunks;
}

export type MemoryCommand =
  | { action: "remember"; content: string }
  | { action: "forget"; keyword: string }
  | { action: "list" };

const REMEMBER_PATTERN = /^(?:你|帮我|请)?(?:记住|记一下|记下|别忘了)[：:，,\s]*([\s\S]+)$/;
const FORGET_PATTERN = /^(?:忘掉|忘记|删掉记忆|删除记忆|清掉记忆)[：:，,\s]*([\s\S]*)$/;
const LIST_PATTERN =
  /^(?:你记得什么|你记住了什么|你记得啥|你记住什么|你记住啥|记忆列表|看看记忆|你有哪些记忆)$/;

/** 识别“记住… / 忘掉… / 你记得什么”这类长期记忆指令 */
export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  const value = text.trim();
  if (!value) return undefined;

  if (LIST_PATTERN.test(value)) return { action: "list" };

  const forget = value.match(FORGET_PATTERN);
  if (forget) {
    const keyword = (forget[1] ?? "").trim();
    return keyword ? { action: "forget", keyword } : undefined;
  }

  const remember = value.match(REMEMBER_PATTERN);
  if (remember) {
    const content = (remember[1] ?? "").trim();
    if (content.length < 2) return undefined;
    // “记住了吗”“记住啊”这种不是指令
    if (/^[了吗嘛呢吧啊呀]+[?？]?$/.test(content)) return undefined;
    return { action: "remember", content: content.slice(0, 500) };
  }

  return undefined;
}
