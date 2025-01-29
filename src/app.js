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
  wxpush: require("./push/wxPusher")
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
  let familyAddedMB = 0;
  
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
  
  return { result, personalAddedMB, familyAddedMB };
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  let familyAddedMB = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(165515815004439);
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
  // ...（保持原有推送逻辑不变）...
}

// 主执行流程
(async () => {
  const capacityData = [];
  const reportLines = ['?? 天翼云盘任务报告'];

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

        // 获取容量信息
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        const originalPersonalGB = cloudCapacityInfo.totalSize / (1024 ** 3);
        const originalFamilyGB = familyCapacityInfo.totalSize / (1024 ** 3);
        
        // 仅记录第一个账号的数据
        if (index === 0) {
          capacityData.push({
            originalPersonalGB,
            originalFamilyGB,
            personalAddedMB,
            familyAddedMB
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

    // 生成容量汇总表（仅显示第一个账号）
    if (capacityData.length > 0) {
      const {
        originalPersonalGB,
        originalFamilyGB,
        personalAddedMB,
        familyAddedMB
      } = capacityData[0];

      const totalPersonalGB = originalPersonalGB + (personalAddedMB / 1024);
      const totalFamilyGB = originalFamilyGB + (familyAddedMB / 1024);

      reportLines.push(
        '?? 容量汇总',
        '┌──────────────┬───────────────┬───────────────┐',
        '│  容量类型    │  个人云       │  家庭云       │',
        '├──────────────┼───────────────┼───────────────┤',
        `│ 原始容量(GB) │ ${originalPersonalGB.toFixed(2).padStart(12)} │ ${originalFamilyGB.toFixed(2).padStart(12)} │`,
        '├──────────────┼───────────────┼───────────────┤',
        `│ 新增容量(MB) │ ${personalAddedMB.toString().padStart(12)} │ ${familyAddedMB.toString().padStart(12)} │`,
        '├──────────────┼───────────────┼───────────────┤',
        `│ 当前总计(GB) │ ${totalPersonalGB.toFixed(2).padStart(12)} │ ${totalFamilyGB.toFixed(2).padStart(12)} │`,
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
