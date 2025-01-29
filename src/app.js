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
  
  return result;
};

const doFamilyTask = async (cloudClient) => {
  const results = [];
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await cloudClient.familyUserSign(familyId);
        results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`);
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务失败：${e.message}`);
  }
  return results;
};

// 通知推送系统
async function sendNotifications(title, content) {
  // 青龙面板通知
  if (typeof $ !== 'undefined' && $.notify) {
    await $.notify(title, content);
  }

  // 原始推送渠道
  const { serverChan, telegramBot, wecomBot, wxpush } = pushConfig;
  
  // ServerChan
  if (serverChan.sendKey) {
    superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
      .send({ title, desp: content })
      .catch(e => logger.error('ServerChan推送失败:', e));
  }

  // Telegram
  if (telegramBot.botToken && telegramBot.chatId) {
    superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
      .send({ 
        chat_id: telegramBot.chatId,
        text: `**${title}**\n${content}`,
        parse_mode: 'Markdown'
      })
      .catch(e => logger.error('Telegram推送失败:', e));
  }

  // 企业微信
  if (wecomBot.key) {
    superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
      .send({
        msgtype: "text",
        text: { 
          content: `${title}\n${content}`,
          mentioned_mobile_list: wecomBot.telphone ? [wecomBot.telphone] : []
        }
      })
      .catch(e => logger.error('企业微信推送失败:', e));
  }

  // WxPusher
  if (wxpush.appToken && wxpush.uid) {
    superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: wxpush.appToken,
        contentType: 1,
        summary: title,
        content: content,
        uids: [wxpush.uid]
      })
      .catch(e => logger.error('WxPusher推送失败:', e));
  }
}

// 主执行流程
(async () => {
  const capacityData = [];
  let totalPersonal = 0;
  let totalFamily = 0;
  const reportLines = ['?? 天翼云盘任务报告'];

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
        const [taskResult, familyResult] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);
        
        // 收集日志
        accountLog.push(...taskResult, ...familyResult);

        // 获取容量信息
        const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
        const personalGB = cloudCapacityInfo.totalSize / (1024 ** 3);
        const familyGB = familyCapacityInfo.totalSize / (1024 ** 3);
        
        // 记录容量数据
        capacityData.push({ user: userMask, personalGB, familyGB });
        totalPersonal += personalGB;
        totalFamily += familyGB;

        // 添加账户摘要
        accountLog.push(
          `?? 存储空间 │ 个人 ${personalGB.toFixed(2)}G │ 家庭 ${familyGB.toFixed(2)}G`,
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

    // 生成容量汇总表
    if (capacityData.length > 0) {
      reportLines.push(
        '?? 容量汇总',
        '┌────────────┬─────────────┬─────────────┐',
        '│  账户名称  │  个人云容量  │  家庭云容量  │',
        '├────────────┼─────────────┼─────────────┤'
      );

      capacityData.forEach(({ user, personalGB, familyGB }) => {
        reportLines.push(
          `│ ${user.padEnd(10)} │ ${personalGB.toFixed(2).padStart(9)}G │ ${familyGB.toFixed(2).padStart(9)}G │`
        );
      });

      reportLines.push(
        '├────────────┼─────────────┼─────────────┤',
        `│ ${'总计'.padEnd(10)} │ ${totalPersonal.toFixed(2).padStart(9)}G │ ${totalFamily.toFixed(2).padStart(9)}G │`,
        '└────────────┴─────────────┴─────────────┘'
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
