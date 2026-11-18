import { describe, expect, spyOn, test } from "bun:test";
import { createChatHandler } from "./chat";
import type { IncomingMessage } from "./chat";
import { ConversationStore } from "./context";

function setup() {
  const history = new ConversationStore(20);
  const replies: string[] = [];
  const prompts: string[] = [];

  const chat = createChatHandler({
    history,
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      return "在的，刚摆了下尾巴。";
    },
    wakeWords: ["大肥鱼", "肥鱼"],
    maxReplyChars: 600,
    timezone: "Asia/Shanghai",
    sleep: async () => {},
  });

  function incoming(
    text: string,
    options: { addressed?: boolean; messageId?: string } & Partial<IncomingMessage> = {},
  ): IncomingMessage {
    return {
      key: "group:1",
      scene: { kind: "group", name: "测试群" },
      messageId: options.messageId ?? `m-${Math.random()}`,
      userId: "u1",
      userName: "小明",
      raw: text,
      mentions: [],
      addressed: options.addressed ?? false,
      reply: async (reply) => {
        replies.push(reply);
        return { id: `sent-${replies.length}` };
      },
      ...options,
    };
  }

  return { chat, history, replies, prompts, incoming };
}

describe("createChatHandler", () => {
  test("没叫到它就只记录上下文，不回复", async () => {
    const { chat, history, replies, incoming } = setup();

    await chat.handle(incoming("今天中午吃啥"));

    expect(replies).toEqual([]);
    expect(history.recent("group:1")).toHaveLength(1);
    expect(history.recent("group:1")[0]?.text).toBe("今天中午吃啥");
  });

  test("@ 它一定回复", async () => {
    const { chat, replies, incoming } = setup();

    await chat.handle(incoming("在吗", { addressed: true }));

    expect(replies).toHaveLength(1);
  });

  test("提到名字也会主动接话，并说明触发方式", async () => {
    const { chat, replies, prompts, incoming } = setup();

    await chat.handle(incoming("大肥鱼你觉得呢"));

    expect(replies).toEqual(["在的，刚摆了下尾巴。"]);
    expect(prompts[0] ?? "").toContain("【触发方式】对方没有 @ 你");
  });

  test("引用了机器人的话也会接", async () => {
    const { chat, history, prompts, incoming } = setup();
    history.add("group:1", {
      id: "b1",
      userId: "bot",
      userName: "大肥鱼",
      text: "昨天说过了",
      timestamp: Date.now(),
      self: true,
    });

    await chat.handle(incoming("<reply,id=b1>那你再说一遍"));

    expect(prompts[0] ?? "").toContain("【触发方式】对方引用了你说过的话");
  });

  test("喊名字 + 指令也能识别", async () => {
    const { chat, history, replies, incoming } = setup();
    history.add("group:1", {
      id: "m0",
      userId: "u1",
      userName: "小明",
      text: "旧消息",
      timestamp: Date.now(),
      self: false,
    });

    await chat.handle(incoming("大肥鱼，重置对话"));

    expect(replies[0]).toContain("全忘了");
    expect(history.recent("group:1")).toHaveLength(0);
  });

  test("同一条消息只处理一次", async () => {
    const { chat, replies, incoming } = setup();
    const message = incoming("大肥鱼在吗", { messageId: "same-id" });

    await chat.handle(message);
    await chat.handle(message);

    expect(replies).toHaveLength(1);
  });

  test("生成失败时回退到兜底话术", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const history = new ConversationStore(20);
    const replies: string[] = [];
    const chat = createChatHandler({
      history,
      generate: async () => {
        throw new Error("boom");
      },
      wakeWords: ["大肥鱼"],
      maxReplyChars: 600,
      timezone: "Asia/Shanghai",
      sleep: async () => {},
    });

    await chat.handle({
      key: "group:1",
      scene: { kind: "group", name: "测试群" },
      messageId: "m1",
      userId: "u1",
      userName: "小明",
      raw: "大肥鱼在吗",
      mentions: [],
      addressed: false,
      reply: async (reply) => {
        replies.push(reply);
      },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]?.length).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });
});
