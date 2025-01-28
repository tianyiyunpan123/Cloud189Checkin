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

// 工具函数
const mask = (s, start, end) => s.split("").fill("*", start, end).join("");
const format = (bytes, unit = "G") => {
  const gb = bytes / 1024 / 1024 / 1024;
  const mb = bytes / 1024 / 1024;
  return unit === "G" 
    ? `${gb.toFixed(2)}G` 
    : `${Math.round(mb)}M`;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 统计对象
let capacityStats = {
  initial: { personal: 0, family: 0 },
  total: { personal: 0, family: 0 },
  added: { personal: 0, family: 0 }
};

// 任务处理函数
const buildTaskResult = (res, result) => {
  const index = result.length;
  res.errorCode === "User_Not_Chance"
    ? result.push(`第${index}次抽奖失败,次数不足`)
    : result.push(`第${index}次抽奖成功,获得${res.prizeName}`);
};

const doTask = async (cloudClient) => {
  const result = [];
  try {
    const res1 = await cloudClient.userSign();
    result.push(`${res1.isSign ? "已签到，" : ""}获得${res1.netdiskBonus}M空间`);
    await delay(2000);

    const res2 = await cloudClient.taskSign();
    buildTaskResult(res2, result);
    await delay(2000);

    const res3 = await cloudClient.taskPhoto();
    buildTaskResult(res3, result);
  } catch (e) {
    logger.error("任务执行异常:", e.message);
  }
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const result = [];
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (!familyInfoResp) return result;

    for (const family of familyInfoResp) {
      const res = await cloudClient.familyUserSign(165515815004439);
      const bonus = res.bonusSpace || 0;
      result.push(`家庭任务${res.signStatus ? "已签到，" : ""}获得${bonus}M空间`);
      capacityStats.added.family += bonus * 1024 * 1024;
      await delay(1000);
    }
  } catch (e) {
    logger.error("家庭任务异常:", e.message);
  }
  return result;
};

// ================= 完整微信推送实现 =================
const pushWecomBot = (title, content) => {
  if (!(wecomBot.key && wecomBot.telphone)) {
    logger.info("企业微信配置不完整，跳过推送");
    return;
  }

  const data = {
    msgtype: "text",
    text: {
      content: `${title}\n\n${content}`,
      mentioned_mobile_list: [wecomBot.telphone]
    }
  };

  superagent
    .post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
    .send(data)
    .then(res => {
      if (res.body.errcode !== 0) throw new Error(res.body.errmsg);
      logger.info("企业微信推送成功");
    })
    .catch(err => {
      logger.error(`企业微信推送失败: ${err.message}`);
    });
};

const pushWxPusher = (title, content) => {
  if (!(wxpush.appToken && wxpush.uid)) {
    logger.info("WxPusher配置不完整，跳过推送");
    return;
  }

  const payload = {
    appToken: wxpush.appToken,
    contentType: 1,
    content: content,
    summary: title,
    uids: [wxpush.uid]
  };

  superagent
    .post("https://wxpusher.zjiecode.com/api/send/message")
    .send(payload)
    .then(res => {
      if (res.body.code !== 1000) throw new Error(res.body.msg);
      logger.info("WxPusher推送成功");
    })
    .catch(err => {
      logger.error(`WxPusher推送失败: ${err.message}`);
    });
};

// 统一推送方法
const push = (title, content) => {
  pushServerChan(title, content);
  pushTelegramBot(title, content);
  pushWecomBot(title, content);
  pushWxPusher(title, content);
};

// 主流程
async function main() {
  let firstAccountInitialized = false;

  for (const [index, account] of accounts.entries()) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    const maskedName = mask(userName, 3, 7);
    try {
      logger.info(`\n🚀 处理账号 ${maskedName}`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 初始化首账号容量
      if (!firstAccountInitialized) {
        const sizeInfo = await client.getUserSizeInfo();
        capacityStats.initial.personal = sizeInfo.cloudCapacityInfo.availableSize;
        capacityStats.initial.family = sizeInfo.familyCapacityInfo.availableSize;
        firstAccountInitialized = true;
      }

      // 并行执行任务
      const [taskRes, familyRes] = await Promise.all([
        doTask(client),
        doFamilyTask(client)
      ]);

      taskRes.forEach(msg => logger.info(msg));
      familyRes.forEach(msg => logger.info(msg));

      // 更新首账号最终容量
      if (index === 0) {
        const sizeInfo = await client.getUserSizeInfo();
        capacityStats.total.personal = sizeInfo.cloudCapacityInfo.availableSize;
        capacityStats.total.family = sizeInfo.familyCapacityInfo.availableSize;
        capacityStats.added.personal = capacityStats.total.personal - capacityStats.initial.personal;
      }

    } catch (e) {
      logger.error(`处理失败: ${e.message}`);
      if (e.code === "ETIMEDOUT") throw e;
    }
  }

  // 生成统计报告
  const statsReport = `
┌───────────────┬───────────────┬───────────────┐
│  容量类型     │  初始容量     │  当前容量     │
├───────────────┼───────────────┼───────────────┤
│ 个人云        │ ${format(capacityStats.initial.personal).padStart(8)} │ ${format(capacityStats.total.personal).padStart(8)} │
│ 家庭云        │ ${format(capacityStats.initial.family).padStart(8)} │ ${format(capacityStats.total.family).padStart(8)} │
└───────────────┴───────────────┴───────────────┘

▎累计新增空间
  个人云：+${format(capacityStats.added.personal, "M")}（仅首账号）
  家庭云：+${format(capacityStats.added.family, "M")}（全部账号）`;

  logger.info("\n📊 容量统计报告" + statsReport);
  return statsReport;
}

// 执行入口
(async () => {
  try {
    const report = await main();
    const events = recording.replay();
    const content = events.map(e => e.data[0]).join("\n");
    push("📢 天翼云盘签到报告", `${content}\n\n${report}`);
  } catch (e) {
    logger.error("主流程异常:", e.message);
    push("❌ 任务执行异常", e.message);
  } finally {
    recording.erase();
  }
})();
