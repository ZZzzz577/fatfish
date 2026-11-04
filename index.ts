import { Bot, ReceiverMode } from "qq-official-bot";
import type { GroupMessageEvent } from "qq-official-bot";
import { agent, extractText } from "./agent";

const appid = Bun.env.APP_ID;
const secret = Bun.env.APP_SECRET;

if (!appid || !secret) {
  console.error("缺少环境变量: 请在 .env 中配置 APP_ID 和 APP_SECRET");
  process.exit(1);
}

const bot = new Bot({
  appid,
  secret,
  mode: ReceiverMode.WEBSOCKET,
  removeAt: true,
  logLevel: "info",
  intents: ["GROUP_AND_C2C_EVENT", "PUBLIC_GUILD_MESSAGES"],
});

async function respond(text: string): Promise<string> {
  if (!text.trim()) return "你想聊点什么？";

  const result = await agent.invoke({
    messages: [{ role: "user", content: text }],
  });

  return extractText(result) || "我没想好怎么回复。";
}

async function handleGroup(event: GroupMessageEvent) {
  try {
    await event.reply(await respond(event.raw_message));
  } catch (err) {
    console.error("处理群消息失败:", err);
    await event.reply("抱歉，我这边出错了，请稍后再试。");
  }
}

bot.on("message.group", handleGroup);

bot.on("message.private", async (event) => {
  try {
    await event.reply(await respond(event.raw_message));
  } catch (err) {
    console.error("处理私聊消息失败:", err);
    await event.reply("抱歉，我这边出错了，请稍后再试。");
  }
});

bot.on("message.guild", async (event) => {
  try {
    await event.reply(await respond(event.raw_message));
  } catch (err) {
    console.error("处理频道消息失败:", err);
    await event.reply("抱歉，我这边出错了，请稍后再试。");
  }
});

bot.on("error", (err) => {
  console.error("机器人错误:", err);
});

await bot.start();
console.log("机器人已启动");

const shutdown = async () => {
  await bot.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
