/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");

// ================= 初始化配置 =================
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" }
  },
  categories: { 
    default: { 
      appenders: ["vcr", "out"], 
      level: process.env.LOG_LEVEL || "info" 
    } 
  }
});

const logger = log4js.getLogger();

// ================= 安全账号配置解析 =================
let accounts = [];
try {
  const accountData = process.env.CLOUD_ACCOUNTS || "[]";
  accounts = JSON.parse(accountData);
  
  if (!Array.isArray(accounts)) {
    logger.error("❌ 配置错误: CLOUD_ACCOUNTS 必须为JSON数组格式");
    accounts = [];
  }
} catch (error) {
  logger.error("❌ 账号配置解析失败:", error.message);
  accounts = [];
}

// ================= 工具函数 =================
const mask = (s, start = 3, end = 7) => 
  s.length > start + end 
    ? `${s.slice(0, start)}${"*".repeat(end - start)}${s.slice(-end)}`
    : s;

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const bytesToUnits = bytes => {
  const gbValue = bytes / 1024 ** 3;
  const mbValue = (bytes % 1024 ** 3) / 1024 ** 2;
  return {
    gb: gbValue >= 0.01 ? parseFloat(gbValue.toFixed(2)) : 0,
    mb: mbValue >= 1 ? Math.round(mbValue) : 0
  };
};

// ================= 容量追踪器 =================
const capacityTracker = {
  firstAccount: {
    prePersonalGB: 0,
    postPersonalGB: 0,
    preFamilyGB: 0,
    personalBonus: { gb: 0, mb: 0 }
  },
  totalFamilyBonus: { gb: 0, mb: 0 },
  processedFamilies: new Set()
};

// ================= 微信推送模块 =================
async function sendWechatNotification(content) {
  const SCKEY = process.env.WECHAT_SCKEY;
  if (!SCKEY) {
    logger.warn("⚠️ 未配置微信推送SCKEY");
    return;
  }

  try {
    const res = await superagent
      .post(`https://sctapi.ftqq.com/${SCKEY}.send`)
      .type('form')
      .send({
        title: "📊 天翼云盘报告",
        desp: content.replace(/\n/g, "\n\n") // Server酱需要双换行
      });

    if (res.body.code === 0) {
      logger.info("📨 微信推送成功");
    } else {
      logger.warn(`❌ 微信推送失败: ${res.body.message}`);
    }
  } catch (error) {
    logger.error("💥 微信推送异常:", error.message);
  }
}

// ================= 任务执行器 =================
async function executeWithRetry(taskName, taskFn, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      await taskFn();
      logger.info(`✅ ${taskName} 成功`);
      return true;
    } catch (error) {
      if (i === retries) {
        logger.error(`❌ ${taskName} 失败: ${error.message}`);
        return false;
      }
      logger.warn(`🔄 ${taskName} 重试中 (${i}/${retries})`);
      await delay(2000 * i);
    }
  }
}

async function performDailyTasks(client) {
  await executeWithRetry("每日签到", () => client.userSign());
  await delay(1500);
  
  await executeWithRetry("每日抽奖", () => client.taskSign());
  await delay(1500);
  
  await executeWithRetry("相册抽奖", () => client.taskPhoto());
}

async function performFamilyTasks(client) {
  try {
    const { familyInfoResp } = await client.getFamilyList();
    if (!familyInfoResp?.length) return;

    for (const family of familyInfoResp) {
      const familyId = family.familyId;
      if (capacityTracker.processedFamilies.has(familyId)) {
        logger.info(`⏩ 跳过已处理家庭 ${familyId}`);
        continue;
      }

      const success = await executeWithRetry(
        `家庭签到 ${familyId}`,
        () => client.familyUserSign(165515815004439)
      );
      
      if (success) {
        capacityTracker.processedFamilies.add(familyId);
        await delay(1000);
      }
    }
  } catch (error) {
    logger.error("💥 家庭任务初始化失败:", error.message);
  }
}

// ================= 账号处理器 =================
async function processAccount(account, index) {
  const { userName, password } = account;
  const maskedName = mask(userName);
  let client;

  try {
    client = new CloudClient(userName, password);
    logger.info(`🔑 ${maskedName} 登录中...`);

    // 登录认证
    await executeWithRetry("账号登录", () => client.login());
    logger.info(`🚀 ${maskedName} 登录成功`);

    // 初始容量记录
    const preCapacity = await client.getUserSizeInfo();
    if (index === 0) {
      capacityTracker.firstAccount.prePersonalGB = bytesToUnits(preCapacity.cloudCapacityInfo.totalSize).gb;
      capacityTracker.firstAccount.preFamilyGB = bytesToUnits(preCapacity.familyCapacityInfo.totalSize).gb;
    }

    // 执行任务链
    await performDailyTasks(client);
    await performFamilyTasks(client);

    // 计算容量变化
    const postCapacity = await client.getUserSizeInfo();
    
    // 家庭容量计算
    const familyDiff = postCapacity.familyCapacityInfo.totalSize - preCapacity.familyCapacityInfo.totalSize;
    const familyBonus = bytesToUnits(familyDiff);
    capacityTracker.totalFamilyBonus.gb += familyBonus.gb;
    capacityTracker.totalFamilyBonus.mb += familyBonus.mb;

    // 个人容量计算（仅首账号）
    if (index === 0) {
      const personalDiff = postCapacity.cloudCapacityInfo.totalSize - preCapacity.cloudCapacityInfo.totalSize;
      const personalBonus = bytesToUnits(personalDiff);
      capacityTracker.firstAccount.postPersonalGB = bytesToUnits(postCapacity.cloudCapacityInfo.totalSize).gb;
      capacityTracker.firstAccount.personalBonus = personalBonus;
    }

    logger.info(`🎉 ${maskedName} 处理完成，家庭新增：${formatCapacity(familyBonus)}`);
  } catch (error) {
    logger.error(`💥 ${maskedName} 处理失败: ${error.message}`);
    throw error;
  } finally {
    await delay(3000);
  }
}

// ================= 报告生成器 =================
function formatCapacity(units) {
  const parts = [];
  if (units.gb > 0) parts.push(`${units.gb.toFixed(2)}GB`);
  if (units.mb > 0) parts.push(`${units.mb}MB`);
  return parts.join(" + ") || "0";
}

function generateCapacityReport() {
  const { 
    firstAccount: { 
      prePersonalGB,
      postPersonalGB,
      preFamilyGB,
      personalBonus 
    },
    totalFamilyBonus
  } = capacityTracker;

  const finalFamilyGB = preFamilyGB + totalFamilyBonus.gb;

  return [
    "📊 ====== 容量报告 ======",
    `主账号：${mask(accounts[0]?.userName || "")}`,
    "├─ 个人空间",
    `│   • 初始：${prePersonalGB.toFixed(2)}GB`,
    `│   • 当前：${postPersonalGB.toFixed(2)}GB (+${formatCapacity(personalBonus)})`,
    "└─ 家庭空间",
    `    • 初始：${preFamilyGB.toFixed(2)}GB`,
    `    • 新增：${formatCapacity(totalFamilyBonus)}`,
    `    • 最终：${finalFamilyGB.toFixed(2)}GB`,
    "=".repeat(30)
  ].join("\n");
}

// ================= 主流程 =================
(async () => {
  try {
    logger.info("🚀 启动天翼云盘自动化任务");
    
    // 账号列表验证
    if (!accounts.length) {
      logger.error("‼️ 错误：未检测到有效账号配置");
      process.exit(1);
    }

    logger.info(`📁 检测到 ${accounts.length} 个账号`);
    
    for (let i = 0; i < accounts.length; i++) {
      await processAccount(accounts[i], i);
    }

    const report = generateCapacityReport();
    logger.info("\n" + report);
    await sendWechatNotification(report);

  } catch (error) {
    logger.error("‼️ 全局错误：" + error.message);
    await sendWechatNotification(`任务失败：${error.message}`);
  } finally {
    recording.erase();
    logger.info("🛑 任务执行结束");
  }
})();
