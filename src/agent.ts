import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";
import { SYSTEM_PROMPT } from "./persona";
import { webTools } from "./web";

const apiKey = Bun.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少环境变量: 请在 .env 中配置 OPENAI_API_KEY");
  process.exit(1);
}

const temperature = Number.parseFloat(Bun.env.OPENAI_TEMPERATURE ?? "0.7");

const model = new ChatOpenAI({
  model: Bun.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey,
  temperature: Number.isFinite(temperature) ? temperature : 0.7,
  configuration: {
    baseURL: Bun.env.OPENAI_BASE_URL || undefined,
  },
});

export const agent = createDeepAgent({
  model,
  systemPrompt: SYSTEM_PROMPT,
  tools: webTools,
});

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

function buildContent(prompt: string, images: readonly string[]): string | ContentBlock[] {
  if (images.length === 0) return prompt;
  return [
    { type: "text", text: prompt },
    ...images.map((url): ContentBlock => ({ type: "image_url", image_url: { url } })),
  ];
}

export interface ReplyInput {
  prompt: string;
  images?: readonly string[];
}

const rawTimeout = Number(Bun.env.OPENAI_TIMEOUT_MS ?? "60000");
const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : 60_000;

async function invoke(content: string | ContentBlock[]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await agent.invoke(
      { messages: [{ role: "user", content }] },
      { signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 调模型拿回复。带图的消息如果模型/网关不支持视觉，自动退化成纯文本再试一次，
 * 避免整条消息直接失败。
 */
export async function generateReply(input: ReplyInput): Promise<string> {
  const images = [...(input.images ?? [])];

  if (images.length > 0) {
    try {
      return extractText(await invoke(buildContent(input.prompt, images)));
    } catch (err) {
      // 超时/中止就别再重试一次了，否则一条消息要等两倍时间
      if (err instanceof Error && /abort/i.test(err.name)) throw err;
      console.warn("图片消息处理失败，改用纯文本重试:", err);
      const fallbackPrompt = `${input.prompt}\n（注意：这次图片没能加载，你看不到图，别假装看到了。）`;
      return extractText(await invoke(fallbackPrompt));
    }
  }

  return extractText(await invoke(input.prompt));
}

export function extractText(result: { messages: unknown[] }): string {
  const last = result.messages.at(-1) as { content?: unknown } | undefined;
  const content = last?.content;

  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) {
        return String((block as { text: unknown }).text);
      }
      return "";
    })
    .join("");
}
