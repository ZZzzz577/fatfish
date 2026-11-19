import { describe, expect, test } from "bun:test";
import {
  cleanReply,
  extractQuotedContent,
  findWakeWord,
  parseMemoryCommand,
  parseRawMessage,
  splitReply,
  stripWakeWords,
} from "./message";

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

  test("全量模式的 <@成员> 写法也能还原", () => {
    const parsed = parseRawMessage("<@A1B2> 你看 <@all> 和 <@!C3D4>", [
      { id: "u1", memberId: "A1B2", name: "小明" },
      { id: "C3D4", memberId: "C3D4", name: "小红" },
    ]);

    expect(parsed.text).toBe("@小明 你看 @全体成员 和 @小红");
  });
});

describe("findWakeWord", () => {
  test("提到名字就命中", () => {
    expect(findWakeWord("大肥鱼你觉得呢", ["大肥鱼", "肥鱼"])).toBe("大肥鱼");
    expect(findWakeWord("问下肥鱼", ["大肥鱼", "肥鱼"])).toBe("肥鱼");
  });

  test("没提名字不命中", () => {
    expect(findWakeWord("今天吃鱼", ["大肥鱼", "肥鱼"])).toBeUndefined();
  });

  test("英文不分大小写", () => {
    expect(findWakeWord("FatFish 在吗", ["fatfish"])).toBe("fatfish");
  });
});

describe("stripWakeWords", () => {
  test("去掉称呼和标点，方便识别指令", () => {
    expect(stripWakeWords("大肥鱼，重置对话", ["大肥鱼", "肥鱼"])).toBe("重置对话");
    expect(stripWakeWords("肥鱼 帮助", ["大肥鱼", "肥鱼"])).toBe("帮助");
  });

  test("没有称呼时原样返回", () => {
    expect(stripWakeWords("  在吗  ", ["大肥鱼"])).toBe("在吗");
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

describe("extractQuotedContent", () => {
  test("取出引用的文字和图片", () => {
    const quoted = extractQuotedContent([
      {
        content: "<@A1B2> 看这个",
        attachments: [{ content_type: "image/png", url: "https://example.com/q.png" }],
      },
    ]);

    expect(quoted?.text).toBe("@某人 看这个");
    expect(quoted?.images).toEqual(["https://example.com/q.png"]);
  });

  test("引用的文件保留文件名，语音转成占位", () => {
    const quoted = extractQuotedContent([
      {
        content: "",
        attachments: [
          { content_type: "application/zip", url: "https://example.com/a.zip", filename: "报表.zip" },
          { content_type: "voice", url: "https://example.com/a.silk" },
        ],
      },
    ]);

    expect(quoted?.text).toBe("【文件】报表.zip\n【语音】");
    expect(quoted?.images).toEqual([]);
  });

  test("没有内容时返回 undefined", () => {
    expect(extractQuotedContent([])).toBeUndefined();
    expect(extractQuotedContent(undefined)).toBeUndefined();
    expect(extractQuotedContent([{ content: "  " }])).toBeUndefined();
  });
});

describe("parseMemoryCommand", () => {
  test("识别记住指令", () => {
    expect(parseMemoryCommand("记住我喜欢吃鱼")).toEqual({
      action: "remember",
      content: "我喜欢吃鱼",
    });
    expect(parseMemoryCommand("帮我记住：周六开黑")).toEqual({
      action: "remember",
      content: "周六开黑",
    });
  });

  test("「记住了吗」不算指令", () => {
    expect(parseMemoryCommand("记住了吗")).toBeUndefined();
    expect(parseMemoryCommand("记住啊")).toBeUndefined();
  });

  test("识别忘掉和查询", () => {
    expect(parseMemoryCommand("忘掉吃鱼")).toEqual({ action: "forget", keyword: "吃鱼" });
    expect(parseMemoryCommand("你记得什么")).toEqual({ action: "list" });
  });
});
