import { describe, expect, test } from "bun:test";
import { cleanReply, parseRawMessage, splitReply } from "./message";

describe("parseRawMessage", () => {
  test("把图片、表情、引用拆成可读内容", () => {
    const parsed = parseRawMessage(
      "<reply,id=r1>看这个<image,url=https://example.com/a.png><face,id=1>",
    );

    expect(parsed.text).toBe("看这个【图片】【表情】");
    expect(parsed.images).toEqual(["https://example.com/a.png"]);
    expect(parsed.quoteId).toBe("r1");
  });

  test("按 mentions 还原 @ 的人名", () => {
    const parsed = parseRawMessage("<at,user_id=u1> 你好 <at,user_id=all>", [
      { id: "u1", name: "小明" },
    ]);

    expect(parsed.text).toBe("@小明 你好 @全体成员");
  });

  test("同一张图不会重复收集，非 http 地址会被忽略", () => {
    const parsed = parseRawMessage(
      "<image,url=https://example.com/a.png><image,url=https://example.com/a.png><image,url=ftp://x/y.png>",
    );

    expect(parsed.images).toEqual(["https://example.com/a.png"]);
  });

  test("不认识的标签原样保留", () => {
    const parsed = parseRawMessage("前<weird,id=1>后");

    expect(parsed.text).toBe("前<weird,id=1>后");
    expect(parsed.images).toEqual([]);
  });
});

describe("cleanReply", () => {
  test("去掉 Markdown 标记、代码围栏和标签", () => {
    const cleaned = cleanReply(
      "## 标题\n**重点** 看 [链接](https://a.com)\n```js\nconst a = 1;\n```\n<image,url=x>",
    );

    expect(cleaned).toBe("标题\n重点 看 链接（https://a.com）\nconst a = 1;");
  });
});

describe("splitReply", () => {
  test("短回复不拆", () => {
    expect(splitReply("咕噜，在的。", 600)).toEqual(["咕噜，在的。"]);
  });

  test("长回复按标点拆开且不超长", () => {
    const chunks = splitReply("这是一句话。".repeat(200), 100);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toContain("这是一句话。");
  });

  test("最多拆成 4 条", () => {
    const chunks = splitReply("啊。".repeat(2000), 50);

    expect(chunks.length).toBe(4);
    expect(chunks.at(-1)?.endsWith("…")).toBe(true);
  });
});
