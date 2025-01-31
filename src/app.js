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

// 新增：容量数据存储对象
let capacityData = {
  firstAccount: {
    personal: { originalGB: 0, addedMB: 0 },
    family: { originalGB: 0, addedMB: 0 }
  },
  totalFamilyAddedMB: 0
};

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

// 修改：返回新增容量数据
const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
    return 0;
  }
  result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  return parseInt(res.prizeName.match(/\d+/)?.[0]) || 0;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 修改：返回新增容量
const doTask = async (cloudClient) => {
  const result = [];
  let addedMB = 0;
  
  const res1 = await cloudClient.userSign();
  addedMB = res1.netdiskBonus || 0;
  result.push(`${res1.isSign ? "已经签到过了，" : ""}签到获得${addedMB}M空间`);
  
  await delay(5000);
  const res2 = await cloudClient.taskSign();
  addedMB += buildTaskResult(res2, result);
  
  await delay(5000);
  const res3 = await cloudClient.taskPhoto();
  addedMB += buildTaskResult(res3, result);

  return { logs: result, addedMB };
};

// 修改：返回家庭容量
const doFamilyTask = async (cloudClient) => {
  const result = [];
  let familyAddedMB = 0;

  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp) {
      for (const family of familyInfoResp) {
        const res = await cloudClient.familyUserSign(family.165515815004439);
        familyAddedMB += res.bonusSpace || 0;
        result.push(`家庭任务${res.signStatus ? "已经签到过了，" : ""}签到获得${res.bonusSpace}M空间`);
      }
    }
  } catch (e) {
    logger.error("家庭任务执行失败:", e.message);
  }
  return { logs: result, familyAddedMB };
};

// 以下推送函数保持不变...

async function main() {
  for (let index = 0; index < accounts.length; index++) {
    const account = accounts[index];
    const { userName, password } = account;
    if (userName && password) {
      const userNameInfo = mask(userName, 3, 7);
      try {
        logger.log(`账户 ${userNameInfo}开始执行`);
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();

        // 修改：获取任务结果和容量数据
        const { logs: taskLogs, addedMB } = await doTask(cloudClient);
        const { logs: familyLogs, familyAddedMB } = await doFamilyTask(cloudClient);

        // 记录首个账号原始容量
        if (index === 0) {
          const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
          capacityData.firstAccount.personal.originalGB = cloudCapacityInfo.totalSize / 1024 / 1024 / 1024;
          capacityData.firstAccount.family.originalGB = familyCapacityInfo.totalSize / 1024 / 1024 / 1024;
          capacityData.firstAccount.personal.addedMB = addedMB;
        }

        // 累计家庭容量（所有账号）
        capacityData.totalFamilyAddedMB += familyAddedMB;

        taskLogs.forEach((r) => logger.log(r));
        familyLogs.forEach((r) => logger.log(r));
        logger.log("任务执行完毕");

      } catch (e) {
        logger.error(e);
        if (e.code === "ETIMEDOUT") throw e;
      }
    }
  }
}

// 新增：生成容量表格
function buildCapacityTable() {
  const personal = capacityData.firstAccount.personal;
  const family = capacityData.firstAccount.family;
  const totalFamilyGB = capacityData.totalFamilyAddedMB / 1024;

  return `
| 类别       | 原容量(GB) | 新增容量(M) | 总容量(GB)     |
|------------|------------|-------------|----------------|
| 个人云     | ${personal.originalGB.toFixed(2)} | ${personal.addedMB} | ${(personal.originalGB + personal.addedMB / 1024).toFixed(2)} |
| 家庭云     | ${family.originalGB.toFixed(2)} | ${capacityData.totalFamilyAddedMB} | ${(family.originalGB + totalFamilyGB).toFixed(2)} |`;
}

(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    let content = events.map((e) => `${e.data.join("")}`).join("  \n");
    
    // 添加容量汇总表格
    content += `\n\n### 📊 容量汇总\n${buildCapacityTable()}`;
    
    push("天翼云盘自动签到任务", content);
    recording.erase();
  }
})();
