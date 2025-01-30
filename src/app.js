/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
log4js.configure({
  appenders: {
    vcr: {
      type: "recording",
    },
    out: {
      type: "console",
    },
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } },
});

const logger = log4js.getLogger();
// process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0'
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 任务 1.签到 2.天天抽红包 3.自动备份抽红包
const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  result.push(
    `${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`
  );
  await delay(5000); // 延迟5秒

  const res2 = await cloudClient.taskSign();
  buildTaskResult(res2, result);

  await delay(5000); // 延迟5秒
  const res3 = await cloudClient.taskPhoto();
  buildTaskResult(res3, result);

  return result;
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  if (familyInfoResp) {
    for (let index = 0; index < familyInfoResp.length; index += 1) {
      const { familyId } = familyInfoResp[index];
      const res = await cloudClient.familyUserSign(165515815004439);
      result.push(
        "家庭任务" +
          `${res.signStatus ? "已经签到过了，" : ""}签到获得${
            res.bonusSpace
          }M空间`
      );
    }
  }
  return result;
};

// ... [保持原有的推送函数不变，此处省略以节省篇幅]

// 修改后的主执行函数
async function main() {
  // 初始化全局汇总数据
  global.summaryData = null;

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const { userName, password } = account;
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`\n账户 ${userNameInfo}开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();
        
        // 执行任务
        const result = await doTask(cloudClient);
        result.forEach((r) => logger.log(r));
        
        // 执行家庭任务
        const familyResult = await doFamilyTask(cloudClient);
        familyResult.forEach((r) => logger.log(r));

        // 容量信息处理（新增部分）
        const { cloudCapacityInfo, familyCapacityInfo } =
          await cloudClient.getUserSizeInfo();

        // 仅处理第一个账号的原始容量
        if (index === 0) {
          const originalPersonalGB = (
            cloudCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2);
          const originalFamilyGB = (
            familyCapacityInfo.totalSize /
            1024 /
            1024 /
            1024
          ).toFixed(2);

          // 提取签到获得的M数
          const signBonusMatch = result.find((r) => r.includes("签到获得"))?.match(/\d+/);
          const signBonusM = signBonusMatch ? signBonusMatch[0] : 0;

          // 计算家庭云新增
          const familyBonusM = familyResult.reduce((sum, r) => {
            const match = r.match(/\d+/);
            return sum + (match ? Number(match[0]) : 0);
          }, 0);

          // 初始化汇总数据
          if (!global.summaryData) {
            global.summaryData = {
              personal: {
                original: originalPersonalGB,
                add: 0
              },
              family: {
                original: originalFamilyGB,
                add: 0
              }
            };
          }

          // 累计数据
          global.summaryData.personal.add += Number(signBonusM);
          global.summaryData.family.add += familyBonusM;
        }

      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") {
          throw e;
        }
      } finally {
        logger.log(`账户 ${userNameInfo}执行完毕`);
      }
    }
  }

  // 添加汇总信息到推送内容（新增部分）
  if (global.summaryData) {
    logger.log(`
📊 容量汇总
──────────────
个人云原容量：${global.summaryData.personal.original}G
本次签到新增：+${global.summaryData.personal.add}M
──────────────
家庭云原容量：${global.summaryData.family.original}G
累计新增容量：+${global.summaryData.family.add}M
──────────────
（多个账号时家庭云容量会累计所有账号的新增空间）`);
  }
}

// ... [保持原有的自执行函数不变]
(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events.map((e) => `${e.data.join("")}`).join("  \n");
    push("天翼云盘自动签到任务", content);
    recording.erase();
  }
})();
