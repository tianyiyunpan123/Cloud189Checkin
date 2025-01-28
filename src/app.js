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
  if (unit === "G") return (bytes / 1024 / 1024 / 1024).toFixed(2) + "G";
  return (bytes / 1024 / 1024).toFixed(0) + "M";
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
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  result.push(
    `${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
  await delay(5000);

  const res2 = await cloudClient.taskSign();
  buildTaskResult(res2, result);
  await delay(5000);

  const res3 = await cloudClient.taskPhoto();
  buildTaskResult(res3, result);

  return result;
};

const doFamilyTask = async (cloudClient) => {
  const result = [];
  const { familyInfoResp } = await cloudClient.getFamilyList();
  
  if (familyInfoResp) {
    for (const family of familyInfoResp) {
      const res = await cloudClient.familyUserSign(165515815004439);
      const bonus = res.bonusSpace || 0;
      result.push(
        `家庭任务${res.signStatus ? "已经签到过了，" : ""}签到获得${bonus}M空间`
      );
      capacityStats.added.family += bonus * 1024 * 1024; // 转换为字节
    }
  }
  return result;
};

// 推送函数（保持原有实现）
const pushServerChan = (title, desp) => { /*...*/ };
const pushTelegramBot = (title, desp) => { /*...*/ };
const pushWecomBot = (title, desp) => { /*...*/ };
const pushWxPusher = (title, desp) => { /*...*/ };

const push = (title, desp) => {
  pushServerChan(title, desp);
  pushTelegramBot(title, desp);
  pushWecomBot(title, desp);
  pushWxPusher(title, desp);
};

// 主流程
async function main() {
  let firstAccountInitialized = false;

  for (const [index, account] of accounts.entries()) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    const maskedName = mask(userName, 3, 7);
    try {
      logger.info(`\n====== 开始处理账号 ${maskedName} ======`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 记录首账号初始容量
      if (!firstAccountInitialized) {
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        capacityStats.initial.personal = cloudCapacityInfo.availableSize;
        capacityStats.initial.family = familyCapacityInfo.availableSize;
        firstAccountInitialized = true;
      }

      // 执行任务
      const [taskResults, familyResults] = await Promise.all([
        doTask(client),
        doFamilyTask(client)
      ]);

      taskResults.forEach(msg => logger.info(msg));
      familyResults.forEach(msg => logger.info(msg));

      // 更新首账号最终容量
      if (index === 0) {
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        capacityStats.total.personal = cloudCapacityInfo.availableSize;
        capacityStats.total.family = familyCapacityInfo.availableSize;
        capacityStats.added.personal = capacityStats.total.personal - capacityStats.initial.personal;
      }

    } catch (e) {
      logger.error(`账号 ${maskedName} 处理失败:`, e.message);
      if (e.code === "ETIMEDOUT") throw e;
    }
  }

  // 生成统计报告
  const statsTable = `
┌───────────────┬───────────────┬───────────────┐
│  容量类型     │  初始容量     │  当前容量     │
├───────────────┼───────────────┼───────────────┤
│ 个人云        │ ${format(capacityStats.initial.personal).padStart(8)} │ ${format(capacityStats.total.personal).padStart(8)} │
│ 家庭云        │ ${format(capacityStats.initial.family).padStart(8)} │ ${format(capacityStats.total.family).padStart(8)} │
└───────────────┴───────────────┴───────────────┘

▎累计新增空间
  个人云：+${format(capacityStats.added.personal, "M")}（仅统计首账号）
  家庭云：+${format(capacityStats.added.family, "M")}（累计所有账号）`;

  logger.info("\n====== 容量统计报告 ======\n" + statsTable);
  return statsTable;
}

// 执行入口
(async () => {
  try {
    const report = await main();
    const events = recording.replay();
    const content = events.map(e => `${e.data.join("")}`).join("\n");
    push("天翼云盘签到报告", `${content}\n\n${report}`);
  } catch (e) {
    logger.error("主流程执行出错:", e);
  } finally {
    recording.erase();
  }
})();
