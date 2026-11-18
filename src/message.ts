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
  id: string;
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
  const images: string[] = [];
  let quoteId: string | undefined;
  let text = "";
  let cursor = 0;

  for (const match of raw.matchAll(TAG_PATTERN)) {
    const [full, rawType = "", rawAttrs] = match;
    const index = match.index ?? 0;
    text += raw.slice(cursor, index);
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
        const name = mentions.find((mention) => mention.id === userId)?.name;
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

  text += raw.slice(cursor);
  text = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

  return { text, images, quoteId };
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
