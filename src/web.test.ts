import { describe, expect, test } from "bun:test";
import { formatFetchedPage, formatSearchResults } from "./web";

describe("formatSearchResults", () => {
  test("整理成模型能读的条目", () => {
    const text = formatSearchResults({
      results: [
        {
          title: "DeepSeek V4 发布",
          url: "https://example.com/news",
          summary: "新一代模型发布。",
          date: "2026-04-24T00:00:00+00:00",
        },
      ],
    });

    expect(text).toContain("1. DeepSeek V4 发布（2026-04-24）");
    expect(text).toContain("https://example.com/news");
    expect(text).toContain("新一代模型发布。");
  });

  test("没有结果时给明确提示", () => {
    expect(formatSearchResults({ results: [] })).toBe("没有搜索到相关结果。");
    expect(formatSearchResults(undefined)).toBe("没有搜索到相关结果。");
  });

  test("缺少摘要时退回 snippet", () => {
    const text = formatSearchResults({
      results: [{ title: "标题", url: "https://example.com", snippet: "短摘要" }],
    });

    expect(text).toContain("短摘要");
  });
});

describe("formatFetchedPage", () => {
  test("返回标题和正文", () => {
    const text = formatFetchedPage({ title: "示例页", content: "# 正文\n内容" });

    expect(text).toContain("标题：示例页");
    expect(text).toContain("# 正文");
  });

  test("正文缺失时给出占位", () => {
    expect(formatFetchedPage({ title: "空页" })).toContain("（没有正文）");
  });
});
