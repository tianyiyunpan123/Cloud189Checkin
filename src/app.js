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

// 微信推送配置
const pushConfig = {
  wxpush: {
    appToken: process.env.WXPUSHER_APP_TOKEN,
    uid: process.env.WXPUSHER_UID
  }
};

const mask = (s, start = 3, end = 7) => 
  s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length + 1;
  result.push(res.errorCode === "User_Not_Chance" 
    ? `第${index}次抽奖失败，次数不足`
    : `第${index}次抽奖成功，获得${res.prizeName}`);
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 提取容量数值的辅助函数
const extractMB = (str) => {
  const match = str.match(/获得(\d+)M空间/);
  return match ? parseInt(match[1]) : 0;
};

const doTask = async (cloudClient) => {
  const result = [];
  try {
    const res1 = await cloudClient.userSign();
    const signMsg = `${res1.isSign ? "已签到" : "签到成功"}，获得${res1.netdiskBonus}M空间`;
    result.push(signMsg);
    await delay(2000);

    const res2 = await cloudClient.taskSign();
    buildTaskResult(res2, result);
    await delay(2000);

    const res3 = await cloudClient.taskPhoto();
    buildTaskResult(res3, result);
  } catch (e) {
    result.push(`任务执行失败：${e.message}`);
  }
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(165515815004439);
        const msg = `${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`;
        results.push(msg);
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
  }
  return results;
};

(async () => {
  let originalPersonalGB = 0;
  let originalFamilyGB = 0;
  let addedPersonalMB = 0;
  let addedFamilyMB = 0;
  const reportLines = ['🏮 天翼云盘任务报告'];

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userMask = mask(userName);
      const accountLog = [];
      
      try {
        const client = new CloudClient(userName, password);
        await client.login();

        // 执行任务
        const [taskResult, familyResult] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);

        // 获取当前容量信息
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        
        // 记录首个账号原始容量
        if (index === 0) {
          originalPersonalGB = cloudCapacityInfo.totalSize / (1024 ** 3);
          originalFamilyGB = familyCapacityInfo.totalSize / (1024 ** 3);
          accountLog.push(
            `📊 存储空间 │ 个人 ${originalPersonalGB.toFixed(2)}G │ 家庭 ${originalFamilyGB.toFixed(2)}G`
          );
        }

        // 统计新增容量
        addedPersonalMB += extractMB(taskResult[0]);
        addedFamilyMB += familyResult.reduce((sum, r) => sum + extractMB(r), 0);

        accountLog.push(...taskResult, ...familyResult, '─'.repeat(40));

      } catch (e) {
        accountLog.push(`❌ 账户异常：${e.message}`);
      } finally {
        reportLines.push(
          `🔐 账户 ${index + 1} │ ${userMask}`,
          ...accountLog.map(l => `  ▪ ${l}`),
          ''
        );
      }
    }

    // 构建容量汇总信息
    if (accounts.length > 0) {
      const totalPersonalGB = originalPersonalGB + (addedPersonalMB / 1024);
      const totalFamilyGB = originalFamilyGB + (addedFamilyMB / 1024);

      reportLines.push(
        '📈 容量汇总表',
        '┌────────────┬───────────────┬───────────────┐',
        '│  账户类型  │  原始容量(GB)  │  新增容量(MB)  │',
        '├────────────┼───────────────┼───────────────┤',
        `│ 个人云空间 │ ${originalPersonalGB.toFixed(2).padStart(10)} │ ${addedPersonalMB.toString().padStart(10)} │`,
        `│ 家庭云空间 │ ${originalFamilyGB.toFixed(2).padStart(10)} │ ${addedFamilyMB.toString().padStart(10)} │`,
        '└────────────┴───────────────┴───────────────┘',
        '',
        `📌 总计容量：`,
        `个人云：${totalPersonalGB.toFixed(2)} GB (${originalPersonalGB.toFixed(2)} + ${(addedPersonalMB/1024).toFixed(2)})`,
        `家庭云：${totalFamilyGB.toFixed(2)} GB (${originalFamilyGB.toFixed(2)} + ${(addedFamilyMB/1024).toFixed(2)})`
      );
    }

  } catch (e) {
    reportLines.push(`⚠ 系统异常：${e.message}`);
  } finally {
    const finalReport = reportLines.join('\n');
    console.log(finalReport);

    // 微信专属推送
    if (pushConfig.wxpush.appToken && pushConfig.wxpush.uid) {
      await superagent.post("https://wxpusher.zjiecode.com/api/send/message")
        .send({
          appToken: pushConfig.wxpush.appToken,
          contentType: 1,
          summary: '📢 天翼云盘签到报告',
          content: finalReport.replace(/G/g, ' GB').replace(/M/g, ' MB'),
          uids: [pushConfig.wxpush.uid]
        })
        .catch(e => logger.error('微信推送失败:', e));
    }

    recording.erase();
  }
})();
