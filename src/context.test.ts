import { describe, expect, test } from "bun:test";
import { ConversationStore } from "./context";

function message(id: string, text: string) {
  return {
    id,
    userId: "u1",
    userName: "小明",
    text,
    timestamp: Date.now(),
    self: false,
  };
}

describe("ConversationStore", () => {
  test("只保留最近 N 条", () => {
    const store = new ConversationStore(3);
    for (let i = 0; i < 5; i += 1) store.add("group:1", message(`m${i}`, `第 ${i} 条`));

    const recent = store.recent("group:1");
    expect(recent.map((item) => item.id)).toEqual(["m2", "m3", "m4"]);
  });

  test("能按 id 找到被引用的消息", () => {
    const store = new ConversationStore(5);
    store.add("group:1", message("m1", "原话"));

    expect(store.find("group:1", "m1")?.text).toBe("原话");
    expect(store.find("group:1", "nope")).toBeUndefined();
  });

  test("不同会话互不影响，清空只清自己的", () => {
    const store = new ConversationStore(5);
    store.add("group:1", message("m1", "a"));
    store.add("group:2", message("m2", "b"));

    store.clear("group:1");

    expect(store.recent("group:1")).toEqual([]);
    expect(store.recent("group:2")).toHaveLength(1);
  });
});
