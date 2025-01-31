/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const { CloudClient } = require("cloud189-sdk");
const superagent = require("superagent");
const accounts = require("../accounts");

// ================= 日志配置 =================
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    console: { type: "console" }
  },
  categories: { 
    default: { 
      appenders: ["vcr", "console"], 
      level: "info" 
    }
  }
});
const logger = log4js.getLogger();
// ===========================================

// 工具函数
const mask = (s) => s.replace(/(\d{3})\d{4}(\d{4})/, "$1****$2");
const bytesToGB = (bytes) => (bytes / 1024 ** 3).toFixed(2);

// 微信推送模块
const wxpush = {
  send: (content) => {
    if (!process.env.WXPUSHER_TOKEN || !process.env.WXPUSHER_UID) return;

    superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: process.env.WXPUSHER_TOKEN,
        content,
        contentType: 1, // 1:文字 3:markdown
        uids: [process.env.WXPUSHER_UID]
      })
      .then(() => logger.info("微信推送已发送"))
      .catch(e => logger.error("微信推送失败:", e.message));
  }
};

// 签到功能类
class Signer {
  constructor(userName, password) {
    this.client = new CloudClient(userName, password);
    this.userTag = mask(userName);
    this.stats = { 
      personal: { original: 0, added: 0 },
      family: { original: 0, added: 0 }
    };
  }

  async init() {
    await this.client.login();
    const sizeInfo = await this.client.getUserSizeInfo();
    this.stats.personal.original = sizeInfo.cloudCapacityInfo.totalSize;
    this.stats.family.original = sizeInfo.familyCapacityInfo.totalSize;
  }

  async personalSign() {
    try {
      const res = await this.client.userSign();
      this.stats.personal.added += res.netdiskBonus;
      logger.info(`[${this.userTag}] 个人 ➕ ${res.netdiskBonus}M`);
    } catch (e) {
      logger.error(`[${this.userTag}] 个人签到失败: ${e.message}`);
    }
  }

  async familySign() {
    try {
      const { familyInfoResp } = await this.client.getFamilyList();
      if (!familyInfoResp) return;

      for (const family of familyInfoResp) {
        try {
          const res = await this.client.familyUserSign(165515815004439);
          this.stats.family.added += res.bonusSpace;
          logger.info(`[${this.userTag}] 家庭「${family.familyName}」➕ ${res.bonusSpace}M`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // 请求间隔
        } catch (e) {
          logger.error(`[${this.userTag}] 家庭签到异常: ${family.familyName}`);
        }
      }
    } catch (e) {
      logger.error(`[${this.userTag}] 家庭列表获取失败`);
    }
  }

  getSummary() {
    return `
[${this.userTag}] 容量报告
┌──────────────────┬─────────────┐
│  类型  │  原始容量  │  本次新增  │
├──────────────────┼─────────────┤
│  个人  │ ${bytesToGB(this.stats.personal.original)}GB  │    +${this.stats.personal.added}M   │
│  家庭  │ ${bytesToGB(this.stats.family.original)}GB  │    +${this.stats.family.added}M   │
└──────────────────┴─────────────┘`;
  }
}

// 主流程
async function main() {
  const allLogs = [];
  
  for (const account of accounts) {
    if (!account.userName || !account.password) continue;

    const signer = new Signer(account.userName, account.password);
    try {
      await signer.init();
      await signer.personalSign();
      await signer.familySign();
      allLogs.push(signer.getSummary());
    } catch (e) {
      logger.error(`[${signer.userTag}] 初始化失败: ${e.message}`);
    }
  }

  return allLogs.join("\n\n");
}

// 执行入口
(async () => {
  try {
    const report = await main();
    const rawLogs = recording.replay().map(e => e.data[0]).join("\n");
    
    // 微信推送组合内容
    const pushContent = `${rawLogs}\n\n${report}`;
    wxpush.send(pushContent);
    
  } catch (e) {
    logger.error("全局异常:", e);
  } finally {
    recording.erase();
  }
})();
