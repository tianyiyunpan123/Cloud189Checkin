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

// 推送配置
const pushConfig = {
  serverChan: require("./push/serverChan"),
  telegramBot: require("./push/telegramBot"),
  wecomBot: require("./push/wecomBot"),
  wxpush: require("./push/wxPusher")
};

// 工具函数
const mask = (s, start = 3, end = 7) => 
  s.split("").fill("*", start, end).join("");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 格式化函数
const formatG = bytes => (bytes / 1024 ** 3).toFixed(2) + 'G';
const formatM = value => `${Math.round(value)}M`.padStart(6);

// 任务逻辑
const doTask = async (client) => {
  const result = [];
  try {
    // 个人签到
    const res1 = await client.userSign();
    result.push(`签到成功 +${res1.netdiskBonus}M`);
    await delay(2000);

    // 每日任务
    const res2 = await client.taskSign();
    if (res2.errorCode === 'User_Not_Chance') {
      result.push('每日抽奖 次数不足');
    } else {
      result.push(`每日抽奖 获得${res2.prizeName}`);
    }
    await delay(2000);

    // 相册任务
    const res3 = await client.taskPhoto();
    if (res3.errorCode === 'User_Not_Chance') {
      result.push('相册抽奖 次数不足');
    } else {
      result.push(`相册抽奖 获得${res3.prizeName}`);
    }
  } catch (e) {
    result.push(`任务失败: ${e.message}`);
  }
  return { result, personalAdded: res1?.netdiskBonus || 0 };
};

const doFamilyTask = async (client) => {
  let familyAdded = 0;
  const result = [];
  try {
    const { familyInfoResp } = await client.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await client.familyUserSign(165515815004439);
        familyAdded += res.bonusSpace || 0;
        result.push(`家庭签到 +${res.bonusSpace}M`);
        await delay(1000);
      }
    }
  } catch (e) {
    result.push(`家庭任务失败: ${e.message}`);
  }
  return { result, familyAdded };
};

// 通知推送
async function sendNotifications(title, content) {
  const { serverChan, telegramBot, wecomBot, wxpush } = pushConfig;
  
  // ServerChan
  if (serverChan.sendKey) {
    superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
      .send({ title, desp: content }).catch(() => {});
  }

  // Telegram
  if (telegramBot.botToken && telegramBot.chatId) {
    superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
      .send({ chat_id: telegramBot.chatId, text: `**${title}**\n${content}` }).catch(() => {});
  }

  // 企业微信
  if (wecomBot.key) {
    superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
      .send({ msgtype: "text", text: { content: `${title}\n${content}` } }).catch(() => {});
  }

  // WxPusher
  if (wxpush.appToken && wxpush.uid) {
    superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({ appToken: wxpush.appToken, content, contentType: 1, uids: [wxpush.uid] }).catch(() => {});
  }
}

// 主流程
(async () => {
  const reportLines = [];
  let firstAccount = null;
  let totalFamilyAdded = 0;

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      try {
        const client = new CloudClient(userName, password);
        await client.login();

        // 执行任务
        const [taskResult, familyResult] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);

        // 获取容量信息
        const sizeInfo = await client.getUserSizeInfo();
        
        // 记录首个账号信息
        if (index === 0) {
          firstAccount = {
            username: mask(userName),
            personalTotal: sizeInfo.cloudCapacityInfo.totalSize,
            familyTotal: sizeInfo.familyCapacityInfo.totalSize,
            personalAdded: taskResult.personalAdded
          };
        }

        // 累计家庭新增
        totalFamilyAdded += familyResult.familyAdded;

        // 记录日志
        reportLines.push(
          `┏ ${mask(userName)} 的任务结果`,
          ...taskResult.result.map(l => `┃ ✔ ${l}`),
          ...familyResult.result.map(l => `┃ 🏠 ${l}`),
          '┗' + '━'.repeat(40)
        );

      } catch (e) {
        reportLines.push(`┏ ${mask(userName)} 执行失败`, `┃ ❗ ${e.message}`, '┗' + '━'.repeat(40));
      }
    }

    // 生成汇总报告
    if (firstAccount) {
      reportLines.unshift(
        '┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓',
        '┃         天翼云盘任务执行报告         ┃',
        '┠──────────────────────────────────────┨'
      );

      reportLines.push(
        '┠──────────────────────────────────────┨',
        '┃            容量变化汇总              ┃',
        '┠──────────────┬────────────┬──────────┨',
        '┃  空间类型    │  总容量    │  新增    ┃',
        '┠──────────────┼────────────┼──────────┨',
        `┃ 个人空间     │ ${formatG(firstAccount.personalTotal).padEnd(10)} │ ${formatM(firstAccount.personalAdded)}  ┃`,
        `┃ 家庭空间累计 │ ${formatG(firstAccount.familyTotal).padEnd(10)} │ ${formatM(totalFamilyAdded)}  ┃`,
        '┗━━━━━━━━━━━━━━┷━━━━━━━━━━━━┷━━━━━━━━━━┛'
      );
    }

  } catch (e) {
    reportLines.push(`全局错误: ${e.message}`);
  } finally {
    const finalReport = reportLines.join('\n');
    console.log('\n\x1b[36m%s\x1b[0m', finalReport);
    await sendNotifications('天翼云盘日报', finalReport);
    recording.erase();
  }
})();
