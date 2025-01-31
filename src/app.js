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

// 全局统计变量
let firstAccountData = null;
let totalFamilyBonus = 0;

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const doTask = async (cloudClient) => {
  const result = [];
  try {
    const signRes = await cloudClient.userSign();
    const bonus = signRes.netdiskBonus || 0;
    result.push(`${signRes.isSign ? "今日已签到，" : ""}获得${bonus}M空间`);
    return { result, bonus };
  } catch (error) {
    result.push(`个人签到失败: ${error.message}`);
    return { result, bonus: 0 };
  }
};

const doFamilyTask = async (cloudClient) => {
  const result = [];
  let totalBonus = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length > 0) {
      for (const family of familyInfoResp) {
        const res = await cloudClient.familyUserSign(165515815004439);
        const bonus = res.bonusSpace || 0;
        result.push(`家庭组「${mask(family.familyId, 4, 8)}」: ${res.signStatus ? "已签到" : "签到成功"}，获得${bonus}M空间`);
        totalBonus += bonus;
      }
    }
  } catch (error) {
    result.push(`家庭签到失败: ${error.message}`);
  }
  return { result, bonus: totalBonus };
};

const pushNotification = (title, content, isWechat = false) => {
  // ServerChan
  if (serverChan.sendKey) {
    superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
      .send({ title, desp: isWechat ? content.replace(/\|/g, "∣") : content })
      .catch(err => logger.error("ServerChan推送失败:", err));
  }

  // Telegram
  if (telegramBot.botToken && telegramBot.chatId) {
    superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
      .send({ chat_id: telegramBot.chatId, text: `${title}\n\n${content}` })
      .catch(err => logger.error("Telegram推送失败:", err));
  }

  // 企业微信
  if (wecomBot.key) {
    superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
      .send({
        msgtype: "markdown",
        markdown: {
          content: `**${title}**\n\`\`\`\n${content}\n\`\`\``
        }
      })
      .catch(err => logger.error("企业微信推送失败:", err));
  }

  // WxPusher
  if (wxpush.appToken && wxpush.uid) {
    superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: wxpush.appToken,
        contentType: isWechat ? 3 : 1,
        summary: title,
        content: isWechat ? content : content.replace(/\|/g, "∣"),
        uids: [wxpush.uid]
      })
      .catch(err => logger.error("WxPusher推送失败:", err));
  }
};

(async () => {
  try {
    const allResults = [];
    
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const maskedName = mask(userName, 3, 7);
      try {
        logger.info(`\n===== 开始处理账户 ${maskedName} =====`);
        
        const client = new CloudClient(userName, password);
        await client.login();

        // 并行执行任务
        const [personalTask, familyTask] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);

        // 获取容量信息
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        
        // 记录首个账户原始数据
        if (index === 0) {
          firstAccountData = {
            originalPersonal: cloudCapacityInfo.totalSize,
            originalFamily: familyCapacityInfo.totalSize,
            personalBonus: personalTask.bonus
          };
        }

        // 累计家庭空间增量
        totalFamilyBonus += familyTask.bonus;

        // 构建结果
        const capacityInfo = [
          `个人容量: ${(cloudCapacityInfo.totalSize / 1073741824).toFixed(2)}G`,
          `家庭容量: ${(familyCapacityInfo.totalSize / 1073741824).toFixed(2)}G`
        ].join(" | ");

        const result = [
          `账户: ${maskedName}`,
          ...personalTask.result,
          ...familyTask.result,
          capacityInfo,
          "────────────────────"
        ].join("\n");

        allResults.push(result);
        logger.info(result);
      } catch (error) {
        const errorMsg = `账户 ${maskedName} 处理失败: ${error.code || error.message}`;
        allResults.push(errorMsg);
        logger.error(errorMsg);
        if (error.code === "ETIMEDOUT") throw error;
      }
    }

    // 生成推送内容
    let finalContent = allResults.join("\n");
    
    // 微信专属表格
    if (firstAccountData) {
      const wechatTable = `\n\n📊 容量汇总表：
| 类型       | 原始容量   | 本次新增   | 当前总量    |
|------------|------------|------------|-------------|
| 个人云     | ${(firstAccountData.originalPersonal / 1073741824).toFixed(2)}GB | ${firstAccountData.personalBonus}M | ${((firstAccountData.originalPersonal / 1073741824) + (firstAccountData.personalBonus / 1024)).toFixed(2)}GB |
| 家庭云     | ${(firstAccountData.originalFamily / 1073741824).toFixed(2)}GB | ${totalFamilyBonus}M | ${((firstAccountData.originalFamily / 1073741824) + (totalFamilyBonus / 1024)).toFixed(2)}GB |`;

      // 普通推送
      pushNotification("📅 天翼云签到日报", finalContent);
      
      // 微信特殊推送
      pushNotification("📅 天翼云签到日报", finalContent + wechatTable, true);
    } else {
      pushNotification("📅 天翼云签到日报", finalContent);
    }
  } finally {
    recording.erase();
  }
})();
