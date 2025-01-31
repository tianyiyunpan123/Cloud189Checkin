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

// 容量统计对象
const capacityData = {
  basePersonalGB: 0,    // 首个账号原个人容量(GB)
  baseFamilyGB: 0,      // 首个账号原家庭容量(GB)
  addedPersonalMB: 0,   // 累计新增个人容量(MB)
  addedFamilyMB: 0      // 累计新增家庭容量(MB)
};

// 工具函数
const mask = (s, start, end) => s.split("").fill("*", start, end).join("");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bytesToGB = (bytes) => (bytes / 1024 ** 3).toFixed(2);

// 签到功能（返回新增容量）
const signPersonal = async (client) => {
  try {
    const res = await client.userSign();
    return { success: true, msg: `+${res.netdiskBonus}M`, value: res.netdiskBonus };
  } catch (e) {
    return { success: false, msg: `失败: ${e.message}`, value: 0 };
  }
};

const signFamily = async (client) => {
  let totalMB = 0;
  const logs = [];
  try {
    const { familyInfoResp } = await client.getFamilyList();
    if (!familyInfoResp) return { logs, totalMB };

    for (const family of familyInfoResp) {
      try {
        await delay(1500);
        const res = await client.familyUserSign(165515815004439);
        totalMB += res.bonusSpace;
        logs.push(`家庭「${family.familyName}」+${res.bonusSpace}M`);
      } catch (e) {
        logs.push(`家庭「${family.familyName}」失败`);
      }
    }
  } catch (e) {
    logs.push("家庭签到初始化失败");
  }
  return { logs, totalMB };
};

// 生成微信表格
const buildWechatTable = () => {
  return `
📊 容量变动汇总
==========================
| 类型  | 原始容量 | 本次新增 |
==========================
| 个人  | ${capacityData.basePersonalGB}GB | +${capacityData.addedPersonalMB}M |
| 家庭  | ${capacityData.baseFamilyGB}GB | +${capacityData.addedFamilyMB}M |
==========================
  `.replace(/ /g, "　"); // 全角空格确保对齐
};

// WxPusher推送
const pushToWechat = (content) => {
  if (!process.env.WXPUSHER_TOKEN || !process.env.WXPUSHER_UID) return;

  superagent.post("https://wxpusher.zjiecode.com/api/send/message")
    .send({
      appToken: process.env.WXPUSHER_TOKEN,
      content: content.replace(/\n/g, "\n\n"), // 增加行间距
      contentType: 3,        // 1:文字 2:html 3:markdown
      topicIds: [],          // 可选主题ID
      uids: [process.env.WXPUSHER_UID]
    })
    .catch(e => logger.error("微信推送失败:", e.message));
};

// 主流程
async function main() {
  for (const [index, account] of accounts.entries()) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    const userTag = mask(userName, 3, 7);
    const logHeader = `[${userTag}]`;
    
    try {
      logger.info(`${logHeader} 开始任务`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 记录首个账号初始容量
      if (index === 0) {
        const sizeInfo = await client.getUserSizeInfo();
        capacityData.basePersonalGB = bytesToGB(sizeInfo.cloudCapacityInfo.totalSize);
        capacityData.baseFamilyGB = bytesToGB(sizeInfo.familyCapacityInfo.totalSize);
      }

      // 执行签到
      const personalRes = await signPersonal(client);
      capacityData.addedPersonalMB += personalRes.value;
      logger.info(`${logHeader} 个人 ${personalRes.msg}`);

      const familyRes = await signFamily(client);
      capacityData.addedFamilyMB += familyRes.totalMB;
      familyRes.logs.forEach(msg => logger.info(`${logHeader} ${msg}`));

    } catch (e) {
      logger.error(`${logHeader} 运行异常: ${e.message}`);
    } finally {
      logger.info(`${logHeader} 任务完成\n──────────`);
    }
  }
}

// 执行入口
(async () => {
  try {
    await main();
  } finally {
    // 生成推送内容
    const rawLogs = recording.replay().map(e => e.data[0]).join("\n");
    const finalContent = `${rawLogs}\n${buildWechatTable()}`;
    
    // 微信推送
    pushToWechat(finalContent);
    recording.erase();
  }
})();
