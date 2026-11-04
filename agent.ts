import { ChatOpenAI } from "@langchain/openai";
import { createDeepAgent } from "deepagents";

const apiKey = Bun.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("缺少环境变量: 请在 .env 中配置 OPENAI_API_KEY");
  process.exit(1);
}

const model = new ChatOpenAI({
  model: Bun.env.OPENAI_MODEL ?? "gpt-4o-mini",
  apiKey,
  temperature: 0,
  configuration: {
    baseURL: Bun.env.OPENAI_BASE_URL || undefined,
  },
});

export const agent = createDeepAgent({
  model,
  systemPrompt: [
    "你是 QQ 群里的智能助手「大肥鱼」。",
    "回复要简洁自然，适合聊天场景，不要使用 Markdown 标题或代码块，除非用户明确要求。",
    "不确定的信息要直说不知道，不要编造。",
  ].join("\n"),
});

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
