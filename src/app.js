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

// 工具函数
const mask = (s, start, end) => s.split("").fill("*", start, end).join("");
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const bytesToGB = bytes => parseFloat((bytes / 1024 ** 3).toFixed(2));

// 初始化容量报告
let capacityReport = {
  firstAccount: {
    prePersonal: 0,
    postPersonal: 0,
    preFamily: 0,
    personalBonus: 0
  },
  totalFamilyBonus: 0
};

async function processAccount(account, index) {
  const { userName, password } = account;
  const maskedName = mask(userName, 3, 7);
  
  try {
    logger.info(`🚀 开始处理账户：${maskedName}`);
    const cloudClient = new CloudClient(userName, password);
    
    // 登录并获取初始容量
    await cloudClient.login();
    const preCapacity = await cloudClient.getUserSizeInfo();
    
    // 记录首账号初始数据
    if (index === 0) {
      capacityReport.firstAccount.prePersonal = bytesToGB(preCapacity.cloudCapacityInfo.totalSize);
      capacityReport.firstAccount.preFamily = bytesToGB(preCapacity.familyCapacityInfo.totalSize);
    }

    // 执行任务
    await Promise.all([
      performDailyTasks(cloudClient),
      performFamilyTasks(cloudClient)
    ]);

    // 获取任务后容量
    const postCapacity = await cloudClient.getUserSizeInfo();
    
    // 计算容量变化
    const familyBonus = bytesToGB(postCapacity.familyCapacityInfo.totalSize - preCapacity.familyCapacityInfo.totalSize);
    capacityReport.totalFamilyBonus += familyBonus;

    // 更新首账号数据
    if (index === 0) {
      capacityReport.firstAccount.postPersonal = bytesToGB(postCapacity.cloudCapacityInfo.totalSize);
      capacityReport.firstAccount.personalBonus = bytesToGB(
        postCapacity.cloudCapacityInfo.totalSize - preCapacity.cloudCapacityInfo.totalSize
      );
    }

    logger.info(`✅ ${maskedName} 处理完成，家庭空间新增：${familyBonus}G`);

  } catch (error) {
    logger.error(`❌ ${maskedName} 处理失败：`, error.message);
    throw error;
  }
}

async function performDailyTasks(client) {
  try {
    await client.userSign();    // 签到
    await delay(3000);
    await client.taskSign();    // 每日抽奖
    await delay(3000);
    await client.taskPhoto();   // 相册抽奖
  } catch (error) {
    logger.warn("任务执行异常：", error.message);
  }
}

async function performFamilyTasks(client) {
  try {
    const { familyInfoResp } = await client.getFamilyList();
    if (familyInfoResp) {
      await Promise.all(familyInfoResp.map(family => 
        client.familyUserSign(family.165515815004439)
      ));
    }
  } catch (error) {
    logger.warn("家庭任务异常：", error.message);
  }
}

function generateCapacityReport() {
  const { firstAccount, totalFamilyBonus } = capacityReport;
  const finalFamily = firstAccount.preFamily + totalFamilyBonus;

  return [
    "📊 ===== 容量变动报告 =====",
    `首账号（${mask(accounts[0].userName, 3, 7)}）`,
    "├─ 个人空间",
    `│   • 初始容量：${firstAccount.prePersonal.toFixed(2)}G`,
    `│   • 当前容量：${firstAccount.postPersonal.toFixed(2)}G (+${firstAccount.personalBonus.toFixed(2)}G)`,
    "└─ 家庭空间",
    `    • 初始容量：${firstAccount.preFamily.toFixed(2)}G`,
    `    • 累计新增：${totalFamilyBonus.toFixed(2)}G`,
    `    • 最终容量：${finalFamily.toFixed(2)}G`,
    "=".repeat(30)
  ].join("\n");
}

// 主执行流程
(async () => {
  try {
    logger.info("🌈 开始执行天翼云盘签到任务");
    
    for (let i = 0; i < accounts.length; i++) {
      await processAccount(accounts[i], i);
      await delay(5000); // 账号间间隔
    }

    const report = generateCapacityReport();
    logger.info("\n" + report);

    // 推送报告（示例用console.log，实际可对接推送渠道）
    console.log("📩 推送通知：\n" + report);

  } catch (error) {
    logger.error("‼️ 全局异常：", error.message);
  } finally {
    recording.erase();
  }
})();
