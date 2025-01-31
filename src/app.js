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
// ...其他推送模块引入保持不变...

// 新增：容量汇总生成函数
function generateCapacitySummary(accountResults) {
  if (!accountResults || accountResults.length === 0) return "";

  const firstAccount = accountResults[0];
  
  // 个人容量计算
  const personalOriginalGB = (firstAccount.personalOriginal / (1024 ** 3)).toFixed(2);
  const personalAdd = firstAccount.personalAdd;
  const personalTotalGB = (parseFloat(personalOriginalGB) + personalAdd / 1024).toFixed(2);

  // 家庭容量计算（累加所有账号）
  const familyOriginalGB = (firstAccount.familyOriginal / (1024 ** 3)).toFixed(2);
  const familyAddTotal = accountResults.reduce((sum, acc) => sum + acc.familyAdd, 0);
  const familyTotalGB = (parseFloat(familyOriginalGB) + familyAddTotal / 1024).toFixed(2);

  return `
【容量汇总】
───────────────
个人空间
原容量: ${personalOriginalGB}GB
本次新增: +${personalAdd}M
当前总计: ${personalTotalGB}GB

家庭空间
原容量: ${familyOriginalGB}GB
累计新增: +${familyAddTotal}M
当前总计: ${familyTotalGB}GB
───────────────`;
}

// 修改后的任务执行函数
const doTask = async (cloudClient) => {
  const result = [];
  let personalAdd = 0;

  // 处理签到任务
  const res1 = await cloudClient.userSign();
  result.push(`${res1.isSign ? "已签到，" : ""}获得${res1.netdiskBonus}M`);
  personalAdd += res1.netdiskBonus;

  // 处理每日抽奖
  const processLottery = async (taskFunc) => {
    await delay(5000);
    const res = await taskFunc();
    buildTaskResult(res, result);
    const match = res.prizeName?.match(/获得(\d+)M空间/);
    return match ? parseInt(match[1], 10) : 0;
  };

  personalAdd += await processLottery(cloudClient.taskSign);
  personalAdd += await processLottery(cloudClient.taskPhoto);

  return { messages: result, personalAdd };
};

// 修改后的家庭任务函数
const doFamilyTask = async (cloudClient) => {
  const result = [];
  let familyAdd = 0;

  const { familyInfoResp } = await cloudClient.getFamilyList();
  if (familyInfoResp) {
    for (const family of familyInfoResp) {
      const res = await cloudClient.familyUserSign(family.165515815004439);
      const bonus = res.bonusSpace || 0;
      result.push(`家庭${family.familyId.slice(-4)}: ${bonus}M`);
      familyAdd += bonus;
    }
  }
  return { messages: result, familyAdd };
};

// 修改后的主函数
async function main() {
  const accountResults = [];
  
  for (const account of accounts) {
    if (!account.userName || !account.password) continue;

    try {
      const cloudClient = new CloudClient(account.userName, account.password);
      await cloudClient.login();

      // 执行任务并收集数据
      const taskResult = await doTask(cloudClient);
      const familyResult = await doFamilyTask(cloudClient);
      const capacityInfo = await cloudClient.getUserSizeInfo();

      // 记录账号数据
      accountResults.push({
        personalOriginal: capacityInfo.cloudCapacityInfo.totalSize,
        familyOriginal: capacityInfo.familyCapacityInfo.totalSize,
        personalAdd: taskResult.personalAdd,
        familyAdd: familyResult.familyAdd
      });

      // 记录日志
      logger.info(`账号 ${mask(account.userName, 3, 7)} 任务完成`);
      taskResult.messages.forEach(msg => logger.info(msg));
      familyResult.messages.forEach(msg => logger.info(msg));

    } catch (e) {
      logger.error(`账号处理失败: ${e.message}`);
    }
  }
  return accountResults;
}

// 修改后的入口函数
(async () => {
  try {
    const accountResults = await main();
    const events = recording.replay();
    
    // 生成推送内容
    const logContent = events.map(e => e.data[0]).join("\n");
    const capacitySummary = generateCapacitySummary(accountResults);
    const fullContent = `${logContent}\n\n${capacitySummary}`;

    // 发送推送
    push("天翼云盘签到完成", fullContent);

  } catch (error) {
    logger.error("执行失败:", error);
  } finally {
    recording.erase();
  }
})();
