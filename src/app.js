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

// ============== 新增全局容量统计 ==============
let capacityData = {
  firstAccount: { personalGB: 0, familyGB: 0 },
  added: { personalMB: 0, familyMB: 0 }
};

// ============== 修改后的任务函数 ==============
const doTask = async (cloudClient) => {
  const result = [];
  try {
    const res1 = await cloudClient.userSign();
    const addedMB = res1.netdiskBonus;
    capacityData.added.personalMB += addedMB;
    result.push(
      `${res1.isSign ? "已经签到过了，" : ""}签到获得${addedMB}M空间`
    );
  } catch (e) {
    result.push("个人签到失败");
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
          const res = await cloudClient.familyUserSign(165515815004439);
          const addedMB = res.bonusSpace;
          capacityData.added.familyMB += addedMB;
          result.push(
            `家庭任务${res.signStatus ? "已经签到过了，" : ""}获得${addedMB}M空间`
          );
        } catch (e) {
          result.push("家庭签到失败");
        }
      }
    }
  } catch (e) {
    result.push("家庭任务初始化失败");
  }
  return result;
};

// ============== 原始推送函数保持不变 ==============
const pushServerChan = (title, desp) => { /* 原有实现 */ };
const pushTelegramBot = (title, desp) => { /* 原有实现 */ };
const pushWecomBot = (title, desp) => { /* 原有实现 */ };
const pushWxPusher = (title, content) => { /* 原有实现 */ };
const push = (title, content) => { /* 原有实现 */ };

// ============== 修改后的主流程 ==============
async function main() {
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    const { userName, password } = account;
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`账户 ${userNameInfo}开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();

        // 记录首个账号原始容量
        if (index === 0) {
          const { cloudCapacityInfo, familyCapacityInfo } = 
            await cloudClient.getUserSizeInfo();
          capacityData.firstAccount.personalGB = 
            (cloudCapacityInfo.totalSize / 1024 ** 3).toFixed(2);
          capacityData.firstAccount.familyGB = 
            (familyCapacityInfo.totalSize / 1024 ** 3).toFixed(2);
        }

        const result = await doTask(cloudClient);
        result.forEach((r) => logger.log(r));
        
        const familyResult = await doFamilyTask(cloudClient);
        familyResult.forEach((r) => logger.log(r));
        
        logger.log("任务执行完毕");

      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") throw e;
      } finally {
        logger.log(`账户 ${userNameInfo}执行完毕`);
      }
    }
  }
}

// ============== 修改后的执行入口 ==============
(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    let content = events.map((e) => `${e.data.join("")}`).join("  \n");
    
    // 添加格式化容量表格
    content += `\n\n📊 容量变动汇总\n` + 
      '|　类型　|　原始容量　|　本次新增　|　总　计　|\n' +
      '|:------:|:----------:|:----------:|:--------:|\n' +
      `|　个人　|　${capacityData.firstAccount.personalGB}GB　|　+${capacityData.added.personalMB}M　|　${capacityData.firstAccount.personalGB}GB+${capacityData.added.personalMB}M　|\n` +
      `|　家庭　|　${capacityData.firstAccount.familyGB}GB　|　+${capacityData.added.familyMB}M　|　${capacityData.firstAccount.familyGB}GB+${capacityData.added.familyMB}M　|`.replace(/ /g, '　');

    push("天翼云盘签到报告", content);
    recording.erase();
  }
})();
