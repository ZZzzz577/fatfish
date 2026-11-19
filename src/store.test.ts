import { describe, expect, test } from "bun:test";
import type { StoredMessage } from "./context";
import { HistoryStore } from "./store";

function message(id: string, text: string, timestamp = Date.now()): StoredMessage {
  return {
    id,
    userId: "u1",
    userName: "小明",
    text,
    timestamp,
    self: false,
  };
}

describe("HistoryStore", () => {
  test("按时间顺序返回最近的消息", () => {
    const store = new HistoryStore(":memory:", 10);
    for (let i = 0; i < 5; i += 1) {
      store.append("group:1", message(`m${i}`, `第 ${i} 条`, 1_000 + i));
    }

    const recent = store.recent("group:1", 3);
    expect(recent.map((item) => item.text)).toEqual(["第 2 条", "第 3 条", "第 4 条"]);
  });

  test("同一条消息重复写入不会变成两条", () => {
    const store = new HistoryStore(":memory:", 10);
    store.append("group:1", message("m1", "你好"));
    store.append("group:1", message("m1", "你好"));

    expect(store.recent("group:1", 10)).toHaveLength(1);
  });

  test("超过保留条数会裁掉最老的", () => {
    const store = new HistoryStore(":memory:", 3);
    for (let i = 0; i < 6; i += 1) {
      store.append("group:1", message(`m${i}`, `第 ${i} 条`, 1_000 + i));
    }

    const recent = store.recent("group:1", 10);
    expect(recent.map((item) => item.text)).toEqual(["第 3 条", "第 4 条", "第 5 条"]);
  });

  test("能列出会话、搜索关键字、清空单个会话", () => {
    const store = new HistoryStore(":memory:", 10);
    store.append("group:1", message("m1", "今晚打游戏吗", 1_000));
    store.append("group:2", message("m2", "另一个群", 2_000));

    expect(store.conversations()).toEqual(["group:2", "group:1"]);
    expect(store.search("group:1", "游戏").map((item) => item.text)).toEqual(["今晚打游戏吗"]);

    store.clear("group:1");
    expect(store.recent("group:1", 10)).toEqual([]);
    expect(store.recent("group:2", 10)).toHaveLength(1);
  });

  test("图片地址能存能取", () => {
    const store = new HistoryStore(":memory:", 10);
    store.append("group:1", {
      ...message("m1", "【图片】"),
      images: ["https://example.com/a.jpg"],
    });

    expect(store.recent("group:1", 10)[0]?.images).toEqual(["https://example.com/a.jpg"]);
  });
});
