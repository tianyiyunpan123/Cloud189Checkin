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
const { CloudClient } = require("cloud189-sdk");
const serverChan = require("./push/serverChan");
const telegramBot = require("./push/telegramBot");
const wecomBot = require("./push/wecomBot");
const wxpush = require("./push/wxPusher");
const accounts = require("../accounts");

// 容量统计模块
const capacityTracker = {
  firstAccount: {
    personal: { original: 0, bonus: 0 },
    family: { original: 0 }
  },
  totalFamilyBonus: 0,
  hasFirstAccount: false,

  recordFirstAccount(cloudData) {
    if (this.hasFirstAccount) return;
    
    this.firstAccount.personal.original = cloudData.personal / (1024 ** 3);
    this.firstAccount.family.original = cloudData.family / (1024 ** 3);
    this.hasFirstAccount = true;
  },

  addPersonalBonus(bonusMB) {
    if (this.hasFirstAccount) {
      this.firstAccount.personal.bonus += bonusMB;
    }
  },

  addFamilyBonus(bonusMB) {
    this.totalFamilyBonus += bonusMB;
  },

  generateTable() {
    const personalTotal = this.firstAccount.personal.original + 
      (this.firstAccount.personal.bonus / 1024);
    const familyTotal = this.firstAccount.family.original + 
      (this.totalFamilyBonus / 1024);

    return [
      "📊 容量汇总表",
      "|  类别  |  原容量  | 新增容量 |  总计  |",
      "|--------|----------|----------|--------|",
      `| 个人云 | ${this.firstAccount.personal.original.toFixed(2)}GB | ` +
      `${this.firstAccount.personal.bonus}M | ${personalTotal.toFixed(2)}GB |`,
      `| 家庭云 | ${this.firstAccount.family.original.toFixed(2)}GB | ` +
      `${this.totalFamilyBonus}M | ${familyTotal.toFixed(2)}GB |`
    ].join("\n");
  }
};

// 任务处理模块
const taskHandler = {
  async personalTask(client) {
    try {
      const res = await client.userSign();
      const bonus = res.isSign ? 0 : res.netdiskBonus;
      return { success: true, bonus, msg: `获得${bonus}M空间` };
    } catch (err) {
      return { success: false, msg: `签到失败: ${err.message}` };
    }
  },

  async familyTask(client) {
    let totalBonus = 0;
    const messages = [];
    
    try {
      const { familyInfoResp } = await client.getFamilyList();
      if (familyInfoResp) {
        for (const family of familyInfoResp) {
          try {
            const res = await client.familyUserSign(family.165515815004439);
            const bonus = res.signStatus ? 0 : res.bonusSpace;
            totalBonus += bonus;
            messages.push(`家庭组[${family.familyId}]获得${bonus}M`);
          } catch (err) {
            messages.push(`家庭组[${family.familyId}]签到失败`);
          }
        }
      }
      return { success: true, bonus: totalBonus, messages };
    } catch (err) {
      return { success: false, msg: `家庭任务失败: ${err.message}` };
    }
  }
};

// 推送适配器
const notifier = {
  async sendAll(title, content) {
    const sendTasks = [
      this._sendServerChan(title, content),
      this._sendTelegram(title, content),
      this._sendWecom(title, content),
      this._sendWxPusher(title, content)
    ];
    
    await Promise.allSettled(sendTasks);
  },

  async _sendServerChan(title, content) {
    if (!serverChan.sendKey) return;
    try {
      await superagent
        .post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
        .send({ title, desp: content });
    } catch (err) {/* 错误处理 */}
  },

  // 其他推送渠道实现类似...
};

// 主业务流程
async function execute() {
  for (const [index, account] of accounts.entries()) {
    const client = new CloudClient(account.userName, account.password);
    
    try {
      await client.login();
      
      // 获取基础容量信息
      const sizeInfo = await client.getUserSizeInfo();
      if (index === 0) {
        capacityTracker.recordFirstAccount({
          personal: sizeInfo.cloudCapacityInfo.totalSize,
          family: sizeInfo.familyCapacityInfo.totalSize
        });
      }

      // 执行任务
      const personalResult = await taskHandler.personalTask(client);
      const familyResult = await taskHandler.familyTask(client);

      // 记录数据
      if (index === 0 && personalResult.success) {
        capacityTracker.addPersonalBonus(personalResult.bonus);
      }
      if (familyResult.success) {
        capacityTracker.addFamilyBonus(familyResult.bonus);
      }

    } catch (err) {
      logger.error(`账号${index + 1}处理失败: ${err.message}`);
    }
  }

  // 生成最终报告
  const report = [
    "✅ 任务执行完成",
    capacityTracker.generateTable(),
    "📝 详细日志请查看服务器记录"
  ].join("\n\n");

  await notifier.sendAll("天翼云盘容量报告", report);
}

// 启动执行
(async () => {
  try {
    await execute();
  } finally {
    recording.erase();
  }
})();
