/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const fs = require("fs");
const path = require("path");

// 增强日志配置
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" },
    file: { 
      type: "dateFile",
      filename: path.join(__dirname, "logs/cloud189"),
      pattern: "yyyy-MM-dd.log",
      alwaysIncludePattern: true,
      compress: true
    }
  },
  categories: { 
    default: { 
      appenders: ["vcr", "out", "file"], 
      level: process.env.DEBUG ? "debug" : "info" 
    } 
  }
});

const logger = log4js.getLogger("main");
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");
const accounts = require("../accounts");

// 创建日志目录
if (!fs.existsSync(path.join(__dirname, "logs"))) {
  fs.mkdirSync(path.join(__dirname, "logs"));
}

// 全局异常处理
process.on("uncaughtException", (err) => {
  logger.fatal("未捕获异常:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("未处理的Promise拒绝:", reason);
});

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

const safeParseNumber = (val, defaultValue = 0) => {
  const num = Number(val);
  return Number.isFinite(num) ? num : defaultValue;
};

// 任务模块
const doTask = async (cloudClient) => {
  const result = [];
  let personalAddMB = 0;

  try {
    // 用户签到
    const res1 = await cloudClient.userSign();
    personalAddMB = safeParseNumber(res1.netdiskBonus);
    result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得${personalAddMB}M空间`);
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
    logger.error("个人任务异常:", e);
  }
  
  return { result, personalAddMB };
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  let familyAddMB = 0;

  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        try {
          const res = await cloudClient.familyUserSign(165515815004439);
          familyAddMB += safeParseNumber(res.bonusSpace);
          results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`);
          await delay(1000);
        } catch (e) {
          results.push(`家庭组 ${familyId} 签到失败: ${e.message}`);
        }
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
    logger.error("家庭任务异常:", e);
  }
  return { results, familyAddMB };
};

// 推送模块
async function sendNotifications(title, content) {
  try {
    // 青龙面板通知
    if (typeof $ !== "undefined" && $.notify) {
      await $.notify(title, content);
    }

    // ServerChan
    if (process.env.SERVERCHAN_KEY) {
      await superagent
        .post(`https://sctapi.ftqq.com/${process.env.SERVERCHAN_KEY}.send`)
        .timeout(10000)
        .send({ title, desp: content });
    }

    // Telegram
    if (process.env.TG_BOT_TOKEN && process.env.TG_CHAT_ID) {
      await superagent
        .post(`https://api.telegram.org/bot${process.env.TG_BOT_TOKEN}/sendMessage`)
        .timeout(10000)
        .send({ 
          chat_id: process.env.TG_CHAT_ID,
          text: `**${title}**\n\`\`\`\n${content}\n\`\`\``,
          parse_mode: "Markdown"
        });
    }

  } catch (e) {
    logger.error("推送通知失败:", e);
  }
}

// 主流程
(async () => {
  const reportLines = ["🏮 天翼云盘任务报告"];
  let capacityData = [];
  let totalFamilyAddMB = 0;

  try {
    logger.info("====== 任务开始执行 ======");

    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) {
        reportLines.push(`⚠ 账户 ${index + 1} 凭证不完整，已跳过`);
        continue;
      }

      const userMask = mask(userName);
      const accountLog = [];
      let personalAddMB = 0, familyAddMB = 0;

      try {
        logger.info(`处理账户 ${userMask}`);
        const client = new CloudClient(userName, password);

        // 登录处理
        try {
          await client.login();
          logger.debug(`${userMask} 登录成功`);
        } catch (e) {
          accountLog.push(`❌ 登录失败: ${e.message}`);
          throw e;
        }

        // 执行任务
        const taskResult = await doTask(client);
        personalAddMB = taskResult.personalAddMB;
        accountLog.push(...taskResult.result);

        const familyResult = await doFamilyTask(client);
        familyAddMB = familyResult.familyAddMB;
        accountLog.push(...familyResult.results);

        // 获取容量信息
        let cloudCapacityInfo, familyCapacityInfo;
        try {
          const sizeInfo = await client.getUserSizeInfo();
          cloudCapacityInfo = sizeInfo.cloudCapacityInfo || {};
          familyCapacityInfo = sizeInfo.familyCapacityInfo || {};
        } catch (e) {
          logger.error("获取容量信息失败:", e);
          cloudCapacityInfo = { totalSize: 0 };
          familyCapacityInfo = { totalSize: 0 };
        }

        // 数据处理
        const personalGB = safeParseNumber(cloudCapacityInfo.totalSize) / (1024 ** 3);
        const familyGB = safeParseNumber(familyCapacityInfo.totalSize) / (1024 ** 3);
        personalAddMB = safeParseNumber(personalAddMB);
        familyAddMB = safeParseNumber(familyAddMB);

        capacityData.push({ user: userMask, personalGB, personalAddMB, familyGB, familyAddMB });
        totalFamilyAddMB += familyAddMB;

        // 账户报告
        accountLog.push(
          `📊 容量变动 │ 个人 +${personalAddMB}M │ 家庭 +${familyAddMB}M`,
          "─".repeat(40)
        );

      } catch (e) {
        accountLog.push(`❌ 处理过程中断: ${e.message}`);
        logger.error(`账户 ${userMask} 处理失败:`, e);
      } finally {
        reportLines.push(
          `🔐 账户 ${index + 1} │ ${userMask}`,
          ...accountLog.map(l => `  ▪ ${l}`),
          ""
        );
      }
    }

    // 生成容量报告
    if (capacityData.length > 0) {
      const firstAccount = capacityData[0];
      const originalPersonal = (firstAccount.personalGB - (firstAccount.personalAddMB / 1024)).toFixed(2);
      const originalFamily = (firstAccount.familyGB - (firstAccount.familyAddMB / 1024)).toFixed(2);

      reportLines.push(
        "📈 容量汇总表",
        "┌────────────┬───────────────────────────┬───────────────────────────┐",
        "│  账户名称  │        个人云容量          │        家庭云容量          │",
        "├────────────┼───────────────────────────┼───────────────────────────┤",
        `│ ${firstAccount.user.padEnd(10)} │ ${originalPersonal} GB (+${firstAccount.personalAddMB} M) │ ${originalFamily} GB (+${firstAccount.familyAddMB} M) │`,
        "├────────────┼───────────────────────────┼───────────────────────────┤",
        `│ ${"总计".padEnd(10)} │ ${originalPersonal} GB + ${firstAccount.personalAddMB} M │ ${originalFamily} GB + ${totalFamilyAddMB} M │`,
        "└────────────┴───────────────────────────┴───────────────────────────┘"
      );
    }

  } catch (e) {
    reportLines.push(`⚠ 系统级错误: ${e.message}`);
    logger.fatal("主流程异常:", e);
  } finally {
    // 生成最终报告
    const finalReport = reportLines.join("\n");
    console.log(finalReport);
    
    try {
      await sendNotifications("天翼云盘任务报告", finalReport);
    } catch (e) {
      logger.error("推送最终报告失败:", e);
    }

    logger.info("====== 任务执行结束 ======");
    recording.erase();
  }
})();
