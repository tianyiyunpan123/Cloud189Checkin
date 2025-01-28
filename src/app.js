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

const parseBonus = (log) => {
  const match = log.match(/获得(\d+)M/);
  return match ? parseInt(match[1]) : 0;
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 核心任务逻辑
const doTask = async (client) => {
  const results = [];
  try {
    const signRes = await client.userSign();
    results.push(`${signRes.isSign ? "已签到" : "签到成功"}，获得${signRes.netdiskBonus}M空间`);
    await delay(2000);

    const lotteryRes = await client.taskSign();
    results.push(lotteryRes.errorCode === "User_Not_Chance" 
      ? "每日抽奖次数已用完"
      : `抽奖获得${lotteryRes.prizeName}`);
    await delay(2000);

    const backupRes = await client.taskPhoto();
    results.push(backupRes.errorCode === "User_Not_Chance" 
      ? "自动备份抽奖次数已用完" 
      : `备份抽奖获得${backupRes.prizeName}`);
  } catch (e) {
    results.push(`任务异常：${e.message}`);
  }
  return results;
};

const doFamilyTask = async (client) => {
  const results = [];
  try {
    const { familyInfoResp } = await client.getFamilyList();
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        const res = await client.familyUserSign(165515815004439);
        results.push(`${res.signStatus ? "已签到" : "签到成功"}，获得${res.bonusSpace}M空间`);
        await delay(1000);
      }
    }
  } catch (e) {
    results.push(`家庭任务异常：${e.message}`);
  }
  return results;
};

// 通知系统（优化版）
async function sendNotifications(title, content) {
  // 青龙面板适配
  if (typeof $ !== 'undefined' && $.notify) {
    await $.notify(title, content.replace(/[│┌┐└┘├┤┬┴]/g, '|'));
  }

  // 原始推送渠道
  const channels = [];
  const { serverChan, telegramBot, wecomBot, wxpush } = pushConfig;

  if (serverChan.sendKey) {
    channels.push(
      superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
        .send({ title, desp: content })
        .catch(e => logger.error('ServerChan推送失败:', e))
    );
  }

  if (telegramBot.botToken && telegramBot.chatId) {
    channels.push(
      superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
        .send({ 
          chat_id: telegramBot.chatId,
          text: `*${title}*\n\`\`\`\n${content}\n\`\`\``,
          parse_mode: 'Markdown'
        })
        .catch(e => logger.error('Telegram推送失败:', e))
    );
  }

  if (wecomBot.key) {
    channels.push(
      superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
        .send({
          msgtype: "text",
          text: {
            content: `${title}\n${content}`,
            mentioned_mobile_list: wecomBot.telphone ? [wecomBot.telphone] : []
          }
        })
        .catch(e => logger.error('企业微信推送失败:', e))
    );
  }

  if (wxpush.appToken && wxpush.uid) {
    channels.push(
      superagent.post("https://wxpusher.zjiecode.com/api/send/message")
        .send({
          appToken: wxpush.appToken,
          contentType: 1,
          summary: title,
          content: content,
          uids: [wxpush.uid]
        })
        .catch(e => logger.error('WxPusher推送失败:', e))
    );
  }

  await Promise.allSettled(channels);
}

// 主执行流程
(async () => {
  let firstAccount = null;
  const report = ['天翼云盘容量报告'];
  const stats = {
    initial: { personal: 0, family: 0 },
    added: { personal: 0, family: 0 },
    total: { personal: 0, family: 0 }
  };

  try {
    for (const [index, account] of accounts.entries()) {
      const { userName, password } = account;
      if (!userName || !password) continue;

      const userInfo = mask(userName);
      const logs = [];
      let accountFamilyAdded = 0;

      try {
        const client = new CloudClient(userName, password);
        await client.login();

        // 记录首账号初始容量
        if (index === 0) {
          const sizeInfo = await client.getUserSizeInfo();
          stats.initial.personal = sizeInfo.cloudCapacityInfo.totalSize;
          stats.initial.family = sizeInfo.familyCapacityInfo.totalSize;
          firstAccount = userInfo;
        }

        // 执行任务
        const [taskLogs, familyLogs] = await Promise.all([
          doTask(client),
          doFamilyTask(client)
        ]);

        // 处理任务结果
        logs.push(...taskLogs, ...familyLogs);

        // 计算家庭容量新增（所有账号）
        accountFamilyAdded = familyLogs
          .map(log => parseBonus(log))
          .reduce((a, b) => a + b, 0);
        stats.added.family += accountFamilyAdded;

        // 如果是首账号，计算个人容量新增
        if (index === 0) {
          const currentSize = await client.getUserSizeInfo();
          stats.added.personal = currentSize.cloudCapacityInfo.totalSize - stats.initial.personal;
        }

        // 生成账户日志
        logs.push(`
  ── 容量变动 ──
  个人空间新增：${(index === 0 ? stats.added.personal/1024**2 : 0).toFixed(2)}M
  家庭空间新增：${accountFamilyAdded}M`);

      } catch (e) {
        logs.push(`执行失败：${e.message}`);
      } finally {
        report.push(
          `▎账户 ${index + 1}：${userInfo}`,
          ...logs.map(l => `  ▸ ${l}`),
          ''
        );
      }
    }

    // 生成容量汇总报告
    if (firstAccount) {
      stats.total.personal = stats.initial.personal + stats.added.personal;
      stats.total.family = stats.initial.family + stats.added.family;

      const format = (bytes, unit = 'G') => {
        const value = bytes / (1024 ** (unit === 'G' ? 3 : 2));
        return `${value.toFixed(2)}${unit}`;
      };

      report.push(`
┌───────────────┬───────────────┬───────────────┐
│  容量类型     │  初始容量     │  当前容量     │
├───────────────┼───────────────┼───────────────┤
│ 个人云        │ ${format(stats.initial.personal).padStart(8)} │ ${format(stats.total.personal).padStart(8)} │
│ 家庭云        │ ${format(stats.initial.family).padStart(8)} │ ${format(stats.total.family).padStart(8)} │
└───────────────┴───────────────┴───────────────┘

▎累计新增空间
  个人云：+${format(stats.added.personal, 'M')}（仅统计首账号）
  家庭云：+${format(stats.added.family, 'M')}（累计所有账号）`);
    }

  } catch (e) {
    report.push(`系统错误：${e.message}`);
  } finally {
    const content = report.join('\n');
    console.log(content);
    await sendNotifications('天翼云盘容量报告', content);
    recording.erase();
  }
})();
