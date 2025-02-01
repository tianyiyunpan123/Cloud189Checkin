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

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ==================== 核心任务逻辑 ====================
const doTask = async (cloudClient) => {
  const result = [];
  try {
    const res = await cloudClient.userSign();
    const personalAdd = res.netdiskBonus;
    result.push(`▸ ${res.isSign ? "已签到" : "签到成功"}，获得 ${personalAdd}M 空间`);
    return { result, personalAdd };
  } catch (e) {
    result.push(`⚠ 任务失败：${e.message}`);
    return { result, personalAdd: 0 };
  }
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  let familyAdd = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      const { familyId } = familyInfoResp[0];
      const res = await cloudClient.familyUserSign(165515815004439);
      const bonus = res.bonusSpace || 0;
      results.push(`▹ 家庭云 ${res.signStatus ? "已签到" : "签到成功"}，获得 ${bonus}M 空间`);
      familyAdd += bonus;
    }
  } catch (e) {
    results.push(`⚠ 家庭任务失败：${e.message}`);
  }
  return { results, familyAdd };
};

// ==================== 推送系统 ====================
async function sendNotifications(title, content) {
  // 青龙面板通知
  if (typeof $ !== 'undefined' && $.notify) {
    await $.notify(title, content);
  }

  const { serverChan, telegramBot, wecomBot, wxpush } = pushConfig;
  
  // ServerChan推送
  if (serverChan.sendKey) {
    superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
      .send({ title, desp: content })
      .catch(e => logger.error('ServerChan推送失败:', e));
  }

  // Telegram推送
  if (telegramBot.botToken && telegramBot.chatId) {
    superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
      .send({ 
        chat_id: telegramBot.chatId,
        text: `**${title}**\n\`\`\`\n${content}\n\`\`\``,
        parse_mode: 'Markdown'
      })
      .catch(e => logger.error('Telegram推送失败:', e));
  }

  // 企业微信推送
  if (wecomBot.key) {
    superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
      .send({
        msgtype: "markdown",
        markdown: {
          content: `**${title}**\n\`\`\`\n${content}\n\`\`\``
        }
      })
      .catch(e => logger.error('企业微信推送失败:', e));
  }

  // WxPusher推送
  if (wxpush.appToken && wxpush.uid) {
    superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: wxpush.appToken,
        contentType: 3,
        summary: title,
        content: `**${title}**\n\`\`\`\n${content}\n\`\`\``,
        uids: [wxpush.uid]
      })
      .catch(e => logger.error('WxPusher推送失败:', e));
  }
}

// ==================== 主执行流程 ====================
(async () => {
  let firstAccountData = null;
  let totalFamilyAdd = 0;
  const reportLines = ['══════════ 天翼云盘任务报告 ══════════'];

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userMask = mask(userName);
      const accountLog = [`\n✦ 账户 ${index + 1} │ ${userMask}`];
      
      try {
        const client = new CloudClient(userName, password);
        await client.login();

        // 执行任务
        const [taskRes, familyRes] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);
        
        // 记录日志
        accountLog.push(...taskRes.result, ...familyRes.results);
        totalFamilyAdd += familyRes.familyAdd;

        // 记录首个账号数据
        if (index === 0) {
          const sizeInfo = await client.getUserSizeInfo();
          firstAccountData = {
            user: userMask,
            personalGB: sizeInfo.cloudCapacityInfo.totalSize / 1024 ** 3,
            familyGB: sizeInfo.familyCapacityInfo.totalSize / 1024 ** 3,
            personalAdd: taskRes.personalAdd
          };
        }

        accountLog.push('├' + '─'.repeat(35));

      } catch (e) {
        accountLog.push(`⚠ 账户异常：${e.message}`);
      } finally {
        reportLines.push(...accountLog);
      }
    }

    // ==================== 生成报表 ====================
    if (firstAccountData) {
      reportLines.push(
        '\n════════════ 容量汇总 ════════════',
        '┌──────────────┬──────────────┬──────────────┐',
        '│   账户名称   │  个人云容量  │  家庭云容量   │',
        '├──────────────┼──────────────┼──────────────┤',
        `│ ${firstAccountData.user.padEnd(12)} │ ${firstAccountData.personalGB.toFixed(2).padStart(10)}G │ ${firstAccountData.familyGB.toFixed(2).padStart(10)}G │`,
        '└──────────────┴──────────────┴──────────────┘',
        '\n════════════ 容量变动 ════════════',
        `  ➤ 首个账号个人云: +${firstAccountData.personalAdd}M`,
        `  ➤ 全部家庭云合计: +${totalFamilyAdd}M`,
        '════════════════════════════════════'
      );
    }

  } catch (e) {
    reportLines.push(`⚠ 系统异常：${e.message}`);
  } finally {
    const finalReport = reportLines.join('\n');
    console.log(finalReport);
    await sendNotifications('☁️ 天翼云签到报告', finalReport);
    recording.erase();
  }
})();
