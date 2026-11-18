import { describe, expect, test } from "bun:test";
import { buildChatPrompt } from "./persona";

describe("buildChatPrompt", () => {
  test("带上场景、最近聊天、被引用消息和当前消息", () => {
    const prompt = buildChatPrompt({
      scene: { kind: "group", name: "养鱼交流群" },
      transcript: [
        {
          id: "m1",
          userId: "u1",
          userName: "小李",
          text: "今天吃啥",
          timestamp: Date.now() - 60_000,
          self: false,
        },
        {
          id: "m2",
          userId: "bot",
          userName: "大肥鱼",
          text: "吃鱼不如吃我",
          timestamp: Date.now() - 30_000,
          self: true,
        },
      ],
      quote: {
        userName: "小王",
        text: "这鱼是不是胖了",
        self: false,
      },
      sender: "小王",
      text: "你看呢",
      imageCount: 0,
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain("QQ 群「养鱼交流群」");
    expect(prompt).toContain("小李：今天吃啥");
    expect(prompt).toContain("大肥鱼：吃鱼不如吃我");
    expect(prompt).toContain("【被引用的消息】\n小王：这鱼是不是胖了");
    expect(prompt).toContain("【当前消息】小王：你看呢");
  });

  test("没有聊天记录时给出占位", () => {
    const prompt = buildChatPrompt({
      scene: { kind: "private" },
      transcript: [],
      sender: "小李",
      text: "在吗",
      imageCount: 0,
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain("（还没有聊天记录）");
    expect(prompt).toContain("QQ 私聊");
  });

  test("只有图片时说明图片数量", () => {
    const prompt = buildChatPrompt({
      scene: { kind: "group", name: "群" },
      transcript: [],
      sender: "小李",
      text: "【图片】",
      imageCount: 2,
      timezone: "Asia/Shanghai",
    });

    expect(prompt).toContain("本次消息带了 2 张图");
  });

  test("列出本条消息 @ 了谁", () => {
    const prompt = buildChatPrompt({
      scene: { kind: "group", name: "群" },
      transcript: [],
      sender: "小李",
      text: "你看看",
      imageCount: 0,
      mentioned: ["小明", "小红"],
      timezone: "Asia/Shanghai",
      trigger: "at",
    });

    expect(prompt).toContain("【本条消息 @ 了】小明、小红");
  });

  test("被提到名字时给出触发说明", () => {
    const prompt = buildChatPrompt({
      scene: { kind: "group", name: "群" },
      transcript: [],
      sender: "小李",
      text: "大肥鱼你觉得呢",
      imageCount: 0,
      timezone: "Asia/Shanghai",
      trigger: "name",
    });

    expect(prompt).toContain("【触发方式】对方没有 @ 你");
  });
});
