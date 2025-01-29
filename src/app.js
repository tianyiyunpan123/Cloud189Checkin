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

// ======================== 推送配置 ========================
const pushConfig = {
  serverChan: {
    sendKey: process.env.SERVERCHAN_KEY
  },
  telegramBot: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  wecomBot: {
    key: process.env.WECOM_KEY,
    telphone: process.env.WECOM_TEL
  },
  wxpush: {
    appToken: process.env.WXPUSHER_APP_TOKEN,
    uid: process.env.WXPUSHER_UID
  }
};

// ======================== 工具函数 ========================
const mask = (s, start = 3, end = 7) => 
  s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  result.push(res.errorCode === "User_Not_Chance" 
    ? `第${index}次抽奖失败，次数不足`
    : `第${index}次抽奖成功，获得${res.prizeName}`);
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ======================== 核心任务逻辑 ========================
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

// ======================== 推送系统 ========================
const pushNotifications = (title, content) => {
  // ServerChan推送
  if (pushConfig.serverChan.sendKey) {
    superagent
      .post(`https://sctapi.ftqq.com/${pushConfig.serverChan.sendKey}.send`)
      .send({ title, desp: content })
      .end((err, res) => {
        if (err) {
          logger.error(`Server酱推送失败: ${err.message}`);
        } else {
          const json = JSON.parse(res.text);
          if (json.code === 0) {
            logger.info("Server酱推送成功");
          } else {
            logger.error(`Server酱推送失败: ${json.message}`);
          }
        }
      });
  }

  // Telegram推送
  if (pushConfig.telegramBot.botToken && pushConfig.telegramBot.chatId) {
    superagent
      .post(`https://api.telegram.org/bot${pushConfig.telegramBot.botToken}/sendMessage`)
      .send({
        chat_id: pushConfig.telegramBot.chatId,
        text: `${title}\n\n${content}`
      })
      .end((err) => {
        if (err) {
          logger.error(`Telegram推送失败: ${err.message}`);
        } else {
          logger.info("Telegram推送成功");
        }
      });
  }

  // 微信Pusher
  if (pushConfig.wxpush.appToken && pushConfig.wxpush.uid) {
    superagent
      .post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: pushConfig.wxpush.appToken,
        contentType: 1,
        summary: title,
        content: content,
        uids: [pushConfig.wxpush.uid]
      })
      .end((err, res) => {
        if (err) {
          logger.error(`微信推送失败: ${err.message}`);
          return;
        }
        const json = JSON.parse(res.text);
        if (json.code === 1000) {
          logger.info("微信推送成功");
        } else {
          logger.error(`微信推送失败: ${json.msg}`);
        }
      });
  }

  // 企业微信机器人
  if (pushConfig.wecomBot.key) {
    superagent
      .post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${pushConfig.wecomBot.key}`)
      .send({
        msgtype: "text",
        text: {
          content: `${title}\n\n${content}`,
          mentioned_mobile_list: pushConfig.wecomBot.telphone ? [pushConfig.wecomBot.telphone] : []
        }
      })
      .end((err) => {
        if (err) {
          logger.error(`企业微信推送失败: ${err.message}`);
        } else {
          logger.info("企业微信推送成功");
        }
      });
  }
};

// ======================== 主执行流程 ========================
(async () => {
  const capacityData = {
    originalPersonal: 0,
    originalFamily: 0,
    totalAddedPersonal: 0,
    totalAddedFamily: 0
  };

  try {
    const accountReports = [];
    
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userMask = mask(userName);
      const report = {
        user: `账户 ${index + 1} (${userMask})`,
        logs: [],
        personalAdded: 0,
        familyAdded: 0
      };

      try {
        const cloudClient = new CloudClient(userName, password);
        await cloudClient.login();

        // 执行任务
        const [taskResult, familyResult] = await Promise.all([
          doTask(cloudClient),
          doFamilyTask(cloudClient)
        ]);

        // 记录数据
        report.personalAdded = taskResult.personalAddedMB;
        report.familyAdded = familyResult.familyAddedMB;
        capacityData.totalAddedPersonal += taskResult.personalAddedMB;
        capacityData.totalAddedFamily += familyResult.familyAddedMB;

        // 获取第一个账号的原始容量
        if (index === 0) {
          const sizeInfo = await cloudClient.getUserSizeInfo();
          capacityData.originalPersonal = sizeInfo.cloudCapacityInfo.totalSize / 1024 ** 3;
          capacityData.originalFamily = sizeInfo.familyCapacityInfo.totalSize / 1024 ** 3;
        }

        // 构建日志
        report.logs.push(
          ...taskResult.result,
          ...familyResult.results,
          `本次获得：个人+${report.personalAdded}M / 家庭+${report.familyAdded}M`,
          "─".repeat(40)
        );
        
        accountReports.push(report);

      } catch (e) {
        report.logs.push(`执行失败: ${e.message}`);
        accountReports.push(report);
        logger.error(`账户 ${index + 1} 执行异常: ${e.message}`);
      }
    }

    // 生成最终报告
    let finalReport = "? 天翼云盘任务报告\n\n";
    
    // 账户明细
    accountReports.forEach(report => {
      finalReport += `${report.user}\n${report.logs.join("\n")}\n\n`;
    });

    // 容量汇总
    finalReport += "? 容量统计\n";
    finalReport += `原始容量：个人 ${capacityData.originalPersonal.toFixed(2)}G / 家庭 ${capacityData.originalFamily.toFixed(2)}G\n`;
    finalReport += `本次新增：个人 +${capacityData.totalAddedPersonal}M / 家庭 +${capacityData.totalAddedFamily}M\n`;
    finalReport += `当前总量：个人 ${(capacityData.originalPersonal + capacityData.totalAddedPersonal/1024).toFixed(2)}G / 家庭 ${(capacityData.originalFamily + capacityData.totalAddedFamily/1024).toFixed(2)}G`;

    // 发送推送
    pushNotifications("天翼云盘签到报告", finalReport);

  } catch (e) {
    logger.error(`全局异常: ${e.message}`);
  } finally {
    recording.erase();
  }
})();
