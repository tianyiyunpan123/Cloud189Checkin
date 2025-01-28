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

// ======================= 新增部分 =======================
const stats = {
  initial: { personal: 0, family: 0 },
  current: { personal: 0, family: 0 },
  added: { personal: 0, family: 0 }
};

const formatSize = (bytes, unit = "auto") => {
  const units = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  
  if (unit === "auto") {
    const gb = bytes / units.GB;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    const mb = bytes / units.MB;
    return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`;
  }
  return `${(bytes / units[unit]).toFixed(2)} ${unit}`;
};
// =======================================================

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

const buildTaskResult = (res, result) => {
  const index = result.length;
  if (res.errorCode === "User_Not_Chance") {
    result.push(`第${index}次抽奖失败,次数不足`);
  } else {
    result.push(`第${index}次抽奖成功,抽奖获得${res.prizeName}`);
  }
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const doTask = async cloudClient => {
  const result = [];
  let personalBonus = 0;

  try {
    const res1 = await cloudClient.userSign();
    const bonusMatch = res1.netdiskBonus.match(/\d+/);
    if (bonusMatch) personalBonus += parseInt(bonusMatch[0]) * 1048576;
    result.push(`${res1.isSign ? "已经签到过了，" : ""}签到获得${res1.netdiskBonus}M空间`);
  } catch (e) {
    result.push("签到任务执行失败");
  }
  await delay(5000);

  try {
    const res2 = await cloudClient.taskSign();
    buildTaskResult(res2, result);
  } catch (e) {
    result.push("每日抽奖任务失败");
  }
  await delay(5000);

  try {
    const res3 = await cloudClient.taskPhoto();
    buildTaskResult(res3, result);
  } catch (e) {
    result.push("相册抽奖任务失败");
  }

  return personalBonus;
};

const doFamilyTask = async cloudClient => {
  let familyBonus = 0;
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    if (familyInfoResp) {
      for (const family of familyInfoResp) {
        const res = await cloudClient.familyUserSign(family.165515815004439);
        familyBonus += parseInt(res.bonusSpace) * 1048576;
        await delay(1000);
      }
    }
  } catch (e) {
    logger.error("家庭任务执行失败:", e.message);
  }
  return familyBonus;
};

// ======================= 修改后的主逻辑 =======================
async function main() {
  if (accounts.length === 0) {
    logger.error("未配置任何账号信息");
    return;
  }

  // 记录首账号初始容量
  try {
    const firstClient = new CloudClient(accounts[0].userName, accounts[0].password);
    await firstClient.login();
    const sizeInfo = await firstClient.getUserSizeInfo();
    stats.initial.personal = sizeInfo.cloudCapacityInfo.totalSize;
    stats.initial.family = sizeInfo.familyCapacityInfo.totalSize;
  } catch (e) {
    logger.error("首账号初始容量获取失败:", e.message);
    return;
  }

  for (let i = 0; i < accounts.length; i++) {
    const { userName, password } = accounts[i];
    if (!userName || !password) continue;

    const maskedName = mask(userName, 3, 7);
    try {
      const client = new CloudClient(userName, password);
      await client.login();

      // 执行任务
      const personalBonus = await doTask(client);
      const familyBonus = await doFamilyTask(client);

      // 更新统计数据
      if (i === 0) {
        stats.added.personal += personalBonus;
        const sizeInfo = await client.getUserSizeInfo();
        stats.current.personal = sizeInfo.cloudCapacityInfo.totalSize;
      }
      stats.added.family += familyBonus;

      logger.info(`账号 ${maskedName} 任务完成`);
    } catch (e) {
      logger.error(`账号 ${maskedName} 执行失败: ${e.message}`);
    }
  }

  // 获取最终家庭空间容量
  try {
    const firstClient = new CloudClient(accounts[0].userName, accounts[0].password);
    await firstClient.login();
    const sizeInfo = await firstClient.getUserSizeInfo();
    stats.current.family = sizeInfo.familyCapacityInfo.totalSize;
  } catch (e) {
    logger.error("最终家庭容量获取失败:", e.message);
  }
}

// ======================= 修改后的输出部分 =======================
(async () => {
  try {
    await main();
  } finally {
    const buildRow = (label, initial, current) => {
      const format = bytes => formatSize(bytes, "GB").replace(" GB", "").padStart(8, " ");
      return `│ ${label.padEnd(12)} │ ${format(initial)} │ ${format(current)} │`;
    };

    const report = [
      "┌────────────────┬──────────────┬──────────────┐",
      "│ 容量类型       │ 初始容量     │ 当前容量     │",
      "├────────────────┼──────────────┼──────────────┤",
      buildRow("个人云", stats.initial.personal, stats.current.personal),
      buildRow("家庭云", stats.initial.family, stats.current.family),
      "└────────────────┴──────────────┴──────────────┘",
      "",
      "▎容量变化汇总",
      `• 个人云新增: ${formatSize(stats.added.personal)} (仅首账号)`,
      `• 家庭云新增: ${formatSize(stats.added.family)} (累计所有账号)`,
      `• 家庭云总计: ${formatSize(stats.current.family)}`
    ].join("\n");

    logger.info("\n" + report);
    push("天翼云盘容量报告", report);
    recording.erase();
  }
})();

// ======================= 以下为原有推送函数 =======================
const pushServerChan = (title, desp) => {
  if (!serverChan.sendKey) return;
  superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
    .send({ title, desp })
    .end((err, res) => {
      if (err) logger.error("ServerChan推送失败:", err);
      else logger.info("ServerChan推送成功");
    });
};

// 其他推送函数（telegramBot、wecomBot、wxpush）保持原有实现
// ...
