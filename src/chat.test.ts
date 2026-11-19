import { describe, expect, spyOn, test } from "bun:test";
import { createChatHandler } from "./chat";
import type { IncomingMessage } from "./chat";
import { ConversationStore } from "./context";

function setup(options: { followUpMs?: number } = {}) {
  let clock = Date.now();
  const history = new ConversationStore(20);
  const replies: string[] = [];
  const prompts: string[] = [];
  const imagesSeen: string[][] = [];

  const chat = createChatHandler({
    history,
    generate: async ({ prompt, images }) => {
      prompts.push(prompt);
      imagesSeen.push([...images]);
      return "在的，刚摆了下尾巴。";
    },
    wakeWords: ["大肥鱼", "肥鱼"],
    maxReplyChars: 600,
    timezone: "Asia/Shanghai",
    sleep: async () => {},
    followUpMs: options.followUpMs ?? 90_000,
    now: () => clock,
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

  return {
    chat,
    history,
    replies,
    prompts,
    imagesSeen,
    incoming,
    advance(ms: number) {
      clock += ms;
    },
  };
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

  test("刚被叫到后，没点名的追问也会回", async () => {
    const { chat, prompts, incoming } = setup();

    await chat.handle(incoming("大肥鱼", { messageId: "m1" }));
    await chat.handle(incoming("今天心情怎么样", { messageId: "m2" }));

    expect(prompts).toHaveLength(2);
    expect(prompts[1] ?? "").toContain("【触发方式】上一句你们还在聊");
  });

  test("窗口内但不是问题就不插嘴", async () => {
    const { chat, replies, incoming } = setup();

    await chat.handle(incoming("大肥鱼", { messageId: "m1" }));
    await chat.handle(incoming("哈哈哈", { messageId: "m2" }));

    expect(replies).toHaveLength(1);
  });

  test("窗口内 @ 别人时不插嘴", async () => {
    const { chat, replies, incoming } = setup();

    await chat.handle(incoming("大肥鱼", { messageId: "m1" }));
    await chat.handle(
      incoming("你觉得呢", { messageId: "m2", mentioned: ["小明"] }),
    );

    expect(replies).toHaveLength(1);
  });

  test("超过窗口就不再主动接", async () => {
    const { chat, replies, incoming, advance } = setup();

    await chat.handle(incoming("大肥鱼", { messageId: "m1" }));
    advance(91_000);
    await chat.handle(incoming("今天心情怎么样", { messageId: "m2" }));

    expect(replies).toHaveLength(1);
  });

  test("把 @ 的人传进提示词", async () => {
    const { chat, prompts, incoming } = setup();

    await chat.handle(incoming("你看看", { addressed: true, mentioned: ["小明"] }));

    expect(prompts[0] ?? "").toContain("【本条消息 @ 了】小明");
  });

  test("图片单独发、下一句再问，也能看到那张图", async () => {
    const { chat, history, prompts, imagesSeen, incoming } = setup();
    history.add("group:1", {
      id: "img1",
      userId: "u1",
      userName: "小明",
      text: "【图片】",
      images: ["https://example.com/pic.jpg"],
      timestamp: Date.now() - 30_000,
      self: false,
    });

    await chat.handle(incoming("这张图啥意思", { addressed: true }));

    expect(imagesSeen[0]).toEqual(["https://example.com/pic.jpg"]);
    expect(prompts[0] ?? "").toContain("【最近的图片】");
  });

  test("图片太旧就不带了", async () => {
    const { chat, history, imagesSeen, incoming } = setup();
    history.add("group:1", {
      id: "img1",
      userId: "u1",
      userName: "小明",
      text: "【图片】",
      images: ["https://example.com/pic.jpg"],
      timestamp: Date.now() - 10 * 60_000,
      self: false,
    });

    await chat.handle(incoming("这张图啥意思", { addressed: true }));

    expect(imagesSeen[0]).toEqual([]);
  });

  test("引用消息的内容会带进提示词", async () => {
    const { chat, prompts, incoming } = setup();

    await chat.handle(
      incoming("这个咋说", {
        addressed: true,
        quoted: { text: "被引用的原话", images: [] },
      }),
    );

    expect(prompts[0] ?? "").toContain("被引用的原话");
  });

  test("引用消息里的图片也会给模型", async () => {
    const { chat, imagesSeen, incoming } = setup();

    await chat.handle(
      incoming("看这张", {
        addressed: true,
        quoted: { text: "", images: ["https://example.com/q.png"] },
      }),
    );

    expect(imagesSeen[0]).toEqual(["https://example.com/q.png"]);
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
