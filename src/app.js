/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" }
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } }
});

const logger = log4js.getLogger();
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ================= 修改后的核心任务 =================
const doTask = async (cloudClient) => {
  const result = [];
  try {
    const res1 = await cloudClient.userSign();
    result.push(
      `${res1.isSign ? "✓ 已签到" : "✔ 签到成功"}，获得${res1.netdiskBonus}M空间`
    );
  } catch (e) {
    result.push(`✗ 个人签到失败: ${e.message}`);
  }
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const result = [];
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp) {
      for (const family of familyInfoResp) {
        try {
          await delay(2000);
          const res = await cloudClient.familyUserSign(165515815004439);
          result.push(
            `家庭「${family.familyName}」` +
            `${res.signStatus ? "✓ 已签到" : "✔ 签到成功"}，获得${res.bonusSpace}M空间`
          );
        } catch (e) {
          result.push(`✗ 家庭「${family.familyName}」签到失败`);
        }
      }
    }
  } catch (e) {
    result.push("✗ 家庭任务初始化失败");
  }
  return result;
};
// ===================================================

// ================= 推送增强版 ======================
const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) return;
  
  superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .type("form")
    .send({ title, desp })
    .then(res => {
      const json = JSON.parse(res.text);
      if (json.code !== 0) {
        logger.error(`Server酱推送失败: ${json.message}`);
      }
    })
    .catch(err => logger.error("Server酱请求异常:", err.message));
};

const pushTelegramBot = (title, desp) => {
  if (!(telegramBot.botToken && telegramBot.chatId)) return;

  superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
    .send({
      chat_id: telegramBot.chatId,
      text: `**${title}**\n${desp}`,
      parse_mode: "Markdown"
    })
    .catch(err => logger.error("Telegram推送失败:", err.message));
};

const pushWecomBot = (title, desp) => {
  if (!(wecomBot.key && wecomBot.telphone)) return;

  superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
    .send({
      msgtype: "markdown",
      markdown: {
        content: `**${title}**\n${desp.replace(/\n/g, "\n\n")}`
      }
    })
    .catch(err => logger.error("企业微信推送失败:", err.message));
};

const pushWxPusher = (title, content) => {
  if (!(wxpush.appToken && wxpush.uid)) return;

  superagent.post("https://wxpusher.zjiecode.com/api/send/message")
    .send({
      appToken: wxpush.appToken,
      contentType: 3, // Markdown格式
      summary: title,
      content: content.replace(/ /g, "　"), // 全角空格对齐
      uids: [wxpush.uid]
    })
    .then(res => {
      if (res.body.code !== 1000) {
        logger.error(`WxPusher错误: ${res.body.msg}`);
      }
    })
    .catch(err => logger.error("微信推送请求失败:", err.message));
};

const push = (title, content) => {
  pushServerChan(title, content);
  pushTelegramBot(title, content);
  pushWecomBot(title, content);
  pushWxPusher(title, content);
};
// ===================================================

// ================= 主流程优化版 =====================
async function main() {
  for (const account of accounts) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    const userTag = mask(userName, 3, 7);
    const logHeader = `[${userTag}]`;
    
    try {
      logger.info(`${logHeader} 任务启动`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 执行核心任务
      const personalLogs = await doTask(client);
      const familyLogs = await doFamilyTask(client);

      // 获取容量信息
      const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
      const capacityLog = [
        "存储空间统计:",
        `个人 ${(cloudCapacityInfo.totalSize / 1024**3).toFixed(2)}G`,
        `家庭 ${(familyCapacityInfo.totalSize / 1024**3).toFixed(2)}G`
      ].join("\n");

      // 记录日志
      personalLogs.forEach(msg => logger.info(`${logHeader} ${msg}`));
      familyLogs.forEach(msg => logger.info(`${logHeader} ${msg}`));
      logger.info(`${logHeader} ${capacityLog}`);

    } catch (e) {
      logger.error(`${logHeader} 执行异常: ${e.message}`);
      if (e.code === "ETIMEDOUT") throw e;
    } finally {
      logger.info(`${logHeader} 任务结束\n`);
    }
  }
}

// ================= 执行入口 ========================
(async () => {
  try {
    await main();
  } finally {
    // 生成推送内容
    const logs = recording.replay()
      .map(e => e.data[0])
      .filter(Boolean)
      .join("\n");

    // 发送所有推送
    push("📅 天翼云盘签到报告", logs);
    recording.erase();
  }
})();
