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
  try {
    const res1 = await cloudClient.userSign();
    result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得${res1.netdiskBonus}M空间`);
    await delay(2000);

    const res2 = await cloudClient.taskSign();
    buildTaskResult(res2, result);
    await delay(2000);

    const res3 = await cloudClient.taskPhoto();
    buildTaskResult(res3, result);
  } catch (e) {
    result.push(`任务执行失败：${e.message}`);
  }
  return { taskResult: result, addedSpace: res1?.netdiskBonus || 0 };
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  let addedFamilySpace = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(165515815004439);
        const bonus = parseInt(res.bonusSpace) || 0;
        results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${bonus}M空间`);
        addedFamilySpace += bonus;
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
  }
  return { familyResult: results, addedFamilySpace };
};

// 通知推送系统
async function sendNotifications(title, content) {
  // ...保持原有推送逻辑不变...
}

// 主执行流程
(async () => {
  let firstAccountPersonalGB = 0;
  let firstAccountFamilyGB = 0;
  let totalAddedPersonalMB = 0;
  let totalAddedFamilyMB = 0;
  const reportLines = ['🏮 天翼云盘任务报告'];

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userMask = mask(userName);
      const accountLog = [];
      
      try {
        // 初始化客户端
        const client = new CloudClient(userName, password);
        await client.login();

        // 执行任务
        const [taskRes, familyRes] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);
        
        // 收集日志和新增空间
        accountLog.push(...taskRes.taskResult, ...familyRes.familyResult);
        totalAddedPersonalMB += taskRes.addedSpace;
        totalAddedFamilyMB += familyRes.addedFamilySpace;

        // 只记录第一个账号的原始容量
        if (index === 0) {
          const sizeInfo = await client.getUserSizeInfo();
          firstAccountPersonalGB = sizeInfo.cloudCapacityInfo.totalSize / (1024 ** 3);
          firstAccountFamilyGB = sizeInfo.familyCapacityInfo.totalSize / (1024 ** 3);
        }

        // 添加账户摘要
        accountLog.push(
          '─'.repeat(40)
        );

      } catch (e) {
        accountLog.push(`❌ 账户异常：${e.message}`);
      } finally {
        // 构建账户报告块
        reportLines.push(
          `🔐 账户 ${index + 1} │ ${userMask}`,
          ...accountLog.map(l => `  ▪ ${l}`),
          ''
        );
      }
    }

    // 生成容量汇总表
    reportLines.push(
      '📈 容量汇总',
      '┌──────────────┬───────────────┬───────────────┐',
      '│  容量类型    │  个人云       │  家庭云       │',
      '├──────────────┼───────────────┼───────────────┤',
      `│ 原始容量(GB) │ ${firstAccountPersonalGB.toFixed(2).padStart(10)} │ ${firstAccountFamilyGB.toFixed(2).padStart(10)} │`,
      '├──────────────┼───────────────┼───────────────┤',
      `│ 新增容量(MB) │ ${String(totalAddedPersonalMB).padStart(10)} │ ${String(totalAddedFamilyMB).padStart(10)} │`,
      '├──────────────┼───────────────┼───────────────┤',
      `│ 当前总计(GB) │ ${(firstAccountPersonalGB + totalAddedPersonalMB/1024).toFixed(2).padStart(10)} │ ${(firstAccountFamilyGB + totalAddedFamilyMB/1024).toFixed(2).padStart(10)} │`,
      '└──────────────┴───────────────┴───────────────┘'
    );

  } catch (e) {
    reportLines.push(`⚠ 系统异常：${e.message}`);
  } finally {
    // 生成最终报告
    const finalReport = reportLines.join('\n');
    console.log(finalReport);
    
    // 微信专属推送格式
    const wxContent = reportLines
      .join('\n')
      .replace(/┌─[^┐]*┐/g, '') // 移除表格线
      .replace(/│/g, '｜')
      .replace(/─+/g, '﹣')
      .replace(/├/g, '├')
      .replace(/└/g, '└')
      .replace(/┴/g, '┴');

    // 单独发送微信推送
    if (pushConfig.wxpush.appToken && pushConfig.wxpush.uid) {
      superagent.post("https://wxpusher.zjiecode.com/api/send/message")
        .send({
          appToken: pushConfig.wxpush.appToken,
          contentType: 1,
          summary: '天翼云盘容量报告',
          content: wxContent,
          uids: [pushConfig.wxpush.uid]
        })
        .catch(e => logger.error('微信推送失败:', e));
    }

    // 其他推送渠道保持原样
    await sendNotifications('天翼云盘签到报告', finalReport);
    
    // 日志系统清理
    recording.erase();
  }
})();
