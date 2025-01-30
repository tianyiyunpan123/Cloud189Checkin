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
const { CloudClient } = require("cloud189-sdk");
const accounts = require("../accounts");

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 简化后的任务：仅保留个人和家庭签到
const doTask = async (cloudClient) => {
  const result = [];
  // 个人签到
  const res = await cloudClient.userSign();
  result.push(
    `${res.isSign ? "已经签到过了，" : ""}个人签到获得${res.netdiskBonus}M空间`
  );
  await delay(2000);
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  if (familyInfoResp) {
    for (const family of familyInfoResp) {
      const res = await cloudClient.familyUserSign(family.165515815004439);
      result.push(
        `家庭[${family.familyName}]签到${
          res.signStatus ? "已存在，" : "成功，"
        }获得${res.bonusSpace}M空间`
      );
      await delay(2000);
    }
  }
  return result;
};

async function main() {
  global.summaryData = {
    personal: { original: 0, add: 0 },
    family: { original: 0, add: 0 }
  };

  for (let i = 0; i < accounts.length; i++) {
    const { userName, password } = accounts[i];
    if (!userName || !password) continue;

    const maskedName = mask(userName, 3, 7);
    try {
      logger.info(`\n🔒 正在处理账号 ${maskedName}`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 执行个人签到
      const personalResult = await doTask(client);
      personalResult.forEach(logger.info);

      // 执行家庭签到
      const familyResult = await doFamilyTask(client);
      familyResult.forEach(logger.info);

      // 获取容量信息
      const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();

      // 记录第一个账号的原始容量
      if (i === 0) {
        global.summaryData.personal.original = (cloudCapacityInfo.totalSize / 1024 ** 3).toFixed(2);
        global.summaryData.family.original = (familyCapacityInfo.totalSize / 1024 ** 3).toFixed(2);
      }

      // 累计容量增量
      const personalAdd = personalResult.reduce((sum, r) => sum + (/\d+/.exec(r)?.[0] || 0), 0);
      const familyAdd = familyResult.reduce((sum, r) => sum + (/\d+/.exec(r)?.[0] || 0), 0);
      
      global.summaryData.personal.add += personalAdd;
      global.summaryData.family.add += familyAdd;

    } catch (e) {
      logger.error(`❌ 账号 ${maskedName} 处理失败:`, e.message);
    } finally {
      logger.info(`✅ 账号 ${maskedName} 处理完成\n${"-".repeat(30)}`);
    }
  }

  // 生成汇总报告
  logger.info(`
📊 容量变动汇总
────────────────────────
个人云 | 原容量: ${global.summaryData.personal.original}G
       | 本次新增: +${global.summaryData.personal.add}M
────────────────────────
家庭云 | 原容量: ${global.summaryData.family.original}G
       | 累计新增: +${global.summaryData.family.add}M
────────────────────────
注：多个账号时家庭云容量会累计所有账号的签到奖励`);

  return global.summaryData;
}

// 执行并推送结果
(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    const content = events.map(e => e.data[0]).join("\n");
    // 这里调用你的推送函数（示例保留推送结构）
    console.log("\n📨 推送内容：\n" + content);
    recording.erase();
  }
})();
