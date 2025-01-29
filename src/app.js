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
const accounts = require("../accounts");

// 推送模块配置
const pushConfig = {
  serverChan: require("./push/serverChan"),
  telegramBot: require("./push/telegramBot"),
  wecomBot: require("./push/wecomBot"),
  wxpush: require("./push/wxPusher") // 已修复的微信推送模块
};

// 工具函数
const mask = (s, start = 3, end = 7) => 
  s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length + 1;
  result.push(res.errorCode === "User_Not_Chance" 
    ? `第${index}次抽奖失败，次数不足`
    : `第${index}次抽奖成功，获得${res.prizeName}`);
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 核心任务逻辑
const doTask = async (cloudClient) => {
  const result = [];
  let personalAddedMB = 0;
  
  try {
    // 用户签到
    const res1 = await cloudClient.userSign();
    personalAddedMB = res1.netdiskBonus || 0;
    result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得${personalAddedMB}M空间`);
    await delay(2000);

    // 任务签到
    const res2 = await cloudClient.taskSign();
    buildTaskResult(res2, result);
    await delay(2000);

    // 照片任务
    const res3 = await cloudClient.taskPhoto();
    buildTaskResult(res3, result);
  } catch (e) {
    result.push(`任务执行失败：${e.message}`);
  }
  
  return { result, personalAddedMB };
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  let familyAddedMB = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(familyId);
        familyAddedMB += res.bonusSpace || 0;
        results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`);
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
  }
  return { results, familyAddedMB };
};

// 通知推送系统
async function sendNotifications(title, content) {
  const hasValidPush = Object.values(pushConfig).some(pusher => {
    const envKeys = Object.keys(process.env);
    return Object.keys(pusher.requiredEnv || []).every(k => envKeys.includes(k));
  });

  if (!hasValidPush) {
    logger.warn("未配置有效推送方式，跳过通知");
    return;
  }

  await Promise.all(
    Object.entries(pushConfig).map(async ([name, pusher]) => {
      try {
        if (pusher.requiredEnv?.every(k => process.env[k])) {
          await pusher.send(title, content);
          logger.info(`推送成功 (${name})`);
        }
      } catch (e) {
        logger.error(`推送失败 (${name}): ${e.message}`);
      }
    })
  );
}

// 主执行流程
(async () => {
  const capacityData = [];
  const reportLines = ['?? 天翼云盘任务报告'];
  let totalFamilyAddedMB = 0; // 累计所有账号的家庭云新增容量

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userMask = mask(userName);
      const accountLog = [];
      let personalAddedMB = 0;
      let familyAddedMB = 0;
      
      try {
        // 初始化客户端
        const client = new CloudClient(userName, password);
        await client.login();

        // 执行任务
        const [taskResult, familyResult] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);
        
        // 收集任务结果
        accountLog.push(...taskResult.result, ...familyResult.results);
        personalAddedMB = taskResult.personalAddedMB;
        familyAddedMB = familyResult.familyAddedMB;

        // 累计家庭云容量
        totalFamilyAddedMB += familyAddedMB;

        // 仅记录第一个账号的原始容量
        if (index === 0) {
          const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
          capacityData.push({
            originalPersonalGB: cloudCapacityInfo.totalSize / (1024 ** 3),
            originalFamilyGB: familyCapacityInfo.totalSize / (1024 ** 3),
            personalAddedMB
          });
        }

        // 添加账户摘要
        accountLog.push(
          `?? 本次获得 │ 个人 +${personalAddedMB}M │ 家庭 +${familyAddedMB}M`,
          '─'.repeat(40)
        );

      } catch (e) {
        accountLog.push(`? 账户异常：${e.message}`);
      } finally {
        // 构建账户报告块
        reportLines.push(
          `?? 账户 ${index + 1} │ ${userMask}`,
          ...accountLog.map(l => `  ? ${l}`),
          ''
        );
      }
    }

    // 生成容量汇总表（第一个账号原始数据 + 累计数据）
    if (capacityData.length > 0) {
      const { originalPersonalGB, originalFamilyGB, personalAddedMB } = capacityData[0];
      const currentPersonalGB = originalPersonalGB + (personalAddedMB / 1024);
      const currentFamilyGB = originalFamilyGB + (totalFamilyAddedMB / 1024);

      reportLines.push(
        '?? 容量汇总',
        '┌──────────────┬───────────────┬───────────────┐',
        '│  容量类型    │  个人云       │  家庭云       │',
        '├──────────────┼───────────────┼───────────────┤',
        `│ 原始容量(GB) │ ${originalPersonalGB.toFixed(2).padStart(12)} │ ${originalFamilyGB.toFixed(2).padStart(12)} │`,
        '├──────────────┼───────────────┼───────────────┤',
        `│ 新增容量(MB) │ ${personalAddedMB.toString().padStart(12)} │ ${totalFamilyAddedMB.toString().padStart(12)} │`,
        '├──────────────┼───────────────┼───────────────┤',
        `│ 当前总计(GB) │ ${currentPersonalGB.toFixed(2).padStart(12)} │ ${currentFamilyGB.toFixed(2).padStart(12)} │`,
        '└──────────────┴───────────────┴───────────────┘'
      );
    }

  } catch (e) {
    reportLines.push(`? 系统异常：${e.message}`);
  } finally {
    // 生成最终报告
    const finalReport = reportLines.join('\n');
    console.log(finalReport);
    
    // 发送通知（兼容青龙和原始推送）
    await sendNotifications('天翼云盘签到报告', finalReport);
    
    // 日志系统清理
    recording.erase();
  }
})();
