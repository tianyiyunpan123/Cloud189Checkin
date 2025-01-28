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

const pushConfig = {
  serverChan: require("./push/serverChan"),
  telegramBot: require("./push/telegramBot"),
  wecomBot: require("./push/wecomBot"),
  wxpush: require("./push/wxPusher")
};

const mask = (s, start = 3, end = 7) => 
  s.split("").fill("*", start, end).join("");

// 修改任务函数返回结构
const doTask = async (cloudClient) => {
  const result = [];
  let personalAddMB = 0; // 新增个人容量

  try {
    const res1 = await cloudClient.userSign();
    personalAddMB = res1.netdiskBonus; // 捕获签到奖励
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
  
  return { result, personalAddMB }; // 返回结果和新增容量
};

// 修改家庭任务函数
const doFamilyTask = async (cloudClient) => {
  const results = [];
  let familyAddMB = 0; // 新增家庭容量

  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(165515815004439);
        familyAddMB += res.bonusSpace; // 累加家庭奖励
        results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`);
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
  }
  return { results, familyAddMB }; // 返回结果和新增容量
};

// 主流程修改
(async () => {
  const capacityData = [];
  let totalFamilyAddMB = 0; // 所有账号家庭新增总和
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

        // 获取任务结果和新增容量
        const { result: taskResult, personalAddMB } = await doTask(client);
        const { results: familyResult, familyAddMB } = await doFamilyTask(client);
        
        // 获取当前总容量
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        const personalGB = cloudCapacityInfo.totalSize / (1024 ** 3);
        const familyGB = familyCapacityInfo.totalSize / (1024 ** 3);

        // 记录容量数据
        capacityData.push({
          user: userMask,
          personalGB,
          personalAddMB,
          familyGB,
          familyAddMB
        });

        // 累计家庭新增
        totalFamilyAddMB += familyAddMB;

        // 构建日志
        accountLog.push(...taskResult, ...familyResult);
        accountLog.push(
          `📊 存储空间 │ 本次获得 ${personalAddMB}M │ 家庭获得 ${familyAddMB}M`,
          '─'.repeat(40)
        );

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

    // 生成新容量汇总表
    if (capacityData.length > 0) {
      const first = capacityData[0];
      const originalPersonal = (first.personalGB - (first.personalAddMB / 1024)).toFixed(2);
      const originalFamily = (first.familyGB - (first.familyAddMB / 1024)).toFixed(2);

      reportLines.push(
        '📈 容量汇总',
        '┌────────────┬───────────────────────────┬───────────────────────────┐',
        '│  账户名称  │        个人云容量          │        家庭云容量          │',
        '├────────────┼───────────────────────────┼───────────────────────────┤',
        `│ ${first.user.padEnd(10)} │ ${originalPersonal} GB (+${first.personalAddMB} M) │ ${originalFamily} GB (+${first.familyAddMB} M) │`,
        '├────────────┼───────────────────────────┼───────────────────────────┤',
        `│ ${'总计'.padEnd(10)} │ ${originalPersonal} GB + ${first.personalAddMB} M │ ${originalFamily} GB + ${totalFamilyAddMB} M │`,
        '└────────────┴───────────────────────────┴───────────────────────────┘'
      );
    }

  } catch (e) {
    reportLines.push(`⚠ 系统异常：${e.message}`);
  } finally {
    const finalReport = reportLines.join('\n');
    console.log(finalReport);
    await sendNotifications('天翼云盘签到报告', finalReport);
    recording.erase();
  }
})();
