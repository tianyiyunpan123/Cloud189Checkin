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

// 配置推送模块（保持原有结构）
const pushHandlers = [/* 各推送渠道配置 */];

// 容量统计对象
const capacityReport = {
  firstAccount: null,
  totalPersonalBonus: 0,
  totalFamilyBonus: 0
};

const mask = (s, start, end) => s.split("").fill("*", start, end).join("");

// 改进的推送处理器
const createPushHandler = (config, requestBuilder) => async (title, desp) => {
  if (!config || !Object.values(config).every(v => v)) return;
  
  try {
    const { method, url, headers, body } = requestBuilder(config, title, desp);
    await superagent[method](url)
      .set(headers)
      .send(body);
    logger.info("推送成功");
  } catch (error) {
    logger.error(`推送失败: ${error.message}`);
  }
};

// 容量处理模块
const capacityUtils = {
  bytesToGB: bytes => (bytes / 1024 ** 3).toFixed(2),
  formatCapacity: (base, bonus) => `${base}GB${bonus ? ` (+${bonus}M)` : ''}`
};

// 任务执行模块
const taskExecutor = {
  delay: ms => new Promise(resolve => setTimeout(resolve, ms)),

  async handleSign(client) {
    const res = await client.userSign();
    const bonus = parseInt(res.netdiskBonus, 10) || 0;
    capacityReport.totalPersonalBonus += bonus;
    return `${res.isSign ? "已签到，" : ""}获得${bonus}M空间`;
  },

  async handleFamilySign(client) {
    let familyBonus = 0;
    const { familyInfoResp } = await client.getFamilyList();
    
    if (familyInfoResp) {
      for (const family of familyInfoResp) {
        const res = await client.familyUserSign(family.165515815004439);
        familyBonus += parseInt(res.bonusSpace, 10) || 0;
      }
    }
    
    capacityReport.totalFamilyBonus += familyBonus;
    return familyBonus > 0 ? `家庭签到获得${familyBonus}M空间` : "无家庭空间奖励";
  }
};

// 主执行流程
async function main() {
  for (const [index, account] of accounts.entries()) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    try {
      logger.info(`处理账户: ${mask(userName, 3, 7)}`);
      const client = new CloudClient(userName, password);
      await client.login();

      // 执行核心任务
      const [signResult, familyResult] = await Promise.all([
        taskExecutor.handleSign(client),
        taskExecutor.handleFamilySign(client)
      ]);

      logger.info(signResult);
      if (familyResult) logger.info(familyResult);

      // 记录首个账号的容量基准
      if (index === 0) {
        const capacityInfo = await client.getUserSizeInfo();
        capacityReport.firstAccount = {
          personal: capacityUtils.bytesToGB(capacityInfo.cloudCapacityInfo.totalSize),
          family: capacityUtils.bytesToGB(capacityInfo.familyCapacityInfo.totalSize)
        };
      }

      await taskExecutor.delay(3000);
    } catch (error) {
      logger.error(`账户处理异常: ${error.message}`);
      if (error.code === "ETIMEDOUT") throw error;
    }
  }
}

// 启动程序
(async () => {
  try {
    await main();
  } finally {
    // 构建最终报告
    const reportContent = [
      "容量汇总报告：",
      `个人空间：${capacityUtils.formatCapacity(
        capacityReport.firstAccount?.personal,
        capacityReport.totalPersonalBonus
      )}`,
      `家庭空间：${capacityUtils.formatCapacity(
        capacityReport.firstAccount?.family,
        capacityReport.totalFamilyBonus
      )}`
    ].join("\n");

    // 发送通知
    const pushTasks = pushHandlers.map(handler => 
      handler(reportContent)
    );
    await Promise.allSettled(pushTasks);

    recording.erase();
  }
})();
