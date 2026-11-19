import { tool } from "@langchain/core/tools";
import { z } from "zod";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 6;
const MAX_SUMMARY_CHARS = 500;
const MAX_PAGE_CHARS = 6000;

const apiKey = Bun.env.SEARCH_API_KEY ?? Bun.env.OPENAI_API_KEY ?? "";
const baseUrl = resolveBaseUrl();
const enabled = Bun.env.WEB_TOOLS !== "off" && Boolean(apiKey);

function resolveBaseUrl(): string {
  const explicit = Bun.env.SEARCH_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const modelBase = Bun.env.OPENAI_BASE_URL?.trim();
  if (modelBase?.includes("deepseek")) return modelBase.replace(/\/+$/, "");

  return DEFAULT_BASE_URL;
}

async function postTool(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`搜索服务返回 ${response.status}：${text.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("搜索服务返回了无法解析的内容");
  }
}

export function formatSearchResults(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "没有搜索到相关结果。";
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results) || results.length === 0) return "没有搜索到相关结果。";

  return results
    .slice(0, MAX_RESULTS)
    .map((item, index) => {
      const result = item as Record<string, unknown>;
      const title = typeof result.title === "string" ? result.title : "无标题";
      const url = typeof result.url === "string" ? result.url : "";
      const rawSummary = result.summary ?? result.snippet ?? "";
      const summary =
        typeof rawSummary === "string"
          ? rawSummary.replace(/\s+/g, " ").slice(0, MAX_SUMMARY_CHARS)
          : "";
      const date = typeof result.date === "string" ? `（${result.date.slice(0, 10)}）` : "";
      return `${index + 1}. ${title}${date}\n${url}\n${summary}`;
    })
    .join("\n\n");
}

export function formatFetchedPage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "标题：无\n\n（没有正文）";
  const page = payload as { title?: unknown; content?: unknown };
  const title = typeof page.title === "string" ? page.title : "";
  const content = typeof page.content === "string" ? page.content : "";

  return [`标题：${title || "无"}`, content.slice(0, MAX_PAGE_CHARS) || "（没有正文）"].join(
    "\n\n",
  );
}

export async function searchWeb(query: string, count = 5): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error("搜索词不能为空");

  console.log(`联网搜索：${trimmed}`);
  const payload = await postTool("/v1/tools/search", {
    query: trimmed.slice(0, 128),
    count,
    need_content: false,
  });
  return formatSearchResults(payload);
}

export async function readWebPage(url: string): Promise<string> {
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error("只支持 http/https 链接");

  console.log(`读取链接：${trimmed}`);
  const payload = await postTool("/v1/tools/fetch", { url: trimmed });
  return formatFetchedPage(payload);
}

const searchTool = tool(
  async ({ query }) => searchWeb(query),
  {
    name: "web_search",
    description:
      "联网搜索最新信息。适合新闻、价格、版本更新、实时事件，以及你不确定的事实。输入搜索词，返回若干条结果的标题、链接和摘要。",
    schema: z.object({
      query: z.string().min(1).max(128).describe("搜索词，可以用 site:、after: 等语法"),
    }),
  },
);

const readUrlTool = tool(
  async ({ url }) => readWebPage(url),
  {
    name: "read_url",
    description:
      "读取一个网页的正文（Markdown）。用户发了链接、或需要点开某条搜索结果细看时使用。",
    schema: z.object({
      url: z.string().url().describe("要读取的 http/https 链接"),
    }),
  },
);

/** 只有配置了 DeepSeek 的 key 且没关掉时才挂载联网工具 */
export const webTools = enabled ? [searchTool, readUrlTool] : [];
