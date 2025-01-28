/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const { CloudClient } = require("cloud189-sdk");
const superagent = require("superagent");

// 日志配置
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" }
  },
  categories: { default: { appenders: ["vcr", "out"], level: "info" } }
});

const logger = log4js.getLogger();

// 容量统计结构
const capacityStats = {
  firstAccount: {
    initial: { personal: 0, family: 0 },
    current: { personal: 0, family: 0 }
  },
  totalAdded: {
    personal: 0,
    family: 0
  }
};

// 工具函数
const formatCapacity = (bytes, unit = 'G') => {
  const units = {
    G: v => (v / 1024**3).toFixed(2) + 'G',
    M: v => (v / 1024**2).toFixed(0) + 'M'
  };
  return units[unit](bytes).padStart(8);
};

const buildTable = (stats) => {
  const header = '┌───────────────┬───────────────┬───────────────┐\n' +
                 '│  容量类型     │  初始容量     │  当前容量     │\n' +
                 '├───────────────┼───────────────┼───────────────┤';

  const personalRow = `│ 个人云        │ ${formatCapacity(stats.initial.personal)} │ ${formatCapacity(stats.current.personal)} │`;
  const familyRow = `│ 家庭云        │ ${formatCapacity(stats.initial.family)} │ ${formatCapacity(stats.current.family)} │`;
  
  return `${header}\n${personalRow}\n${familyRow}\n` +
         '└───────────────┴───────────────┴───────────────┘';
};

// 任务执行模块
async function executeTasks(client) {
  try {
    // 基础任务
    await client.userSign();
    await delay(3000);
    
    // 抽奖任务
    await client.taskSign();
    await delay(3000);
    await client.taskPhoto();
    
    // 家庭任务
    const familyTasks = await client.getFamilyList();
    return Promise.all(familyTasks.map(f => client.familyUserSign(165515815004439);
  } catch (error) {
    logger.error(`任务执行失败: ${error.message}`);
  }
}

// 容量统计模块
async function collectCapacityData(client, isFirstAccount) {
  const sizeInfo = await client.getUserSizeInfo();
  
  if (isFirstAccount) {
    capacityStats.firstAccount.initial = {
      personal: sizeInfo.cloudCapacityInfo.totalSize,
      family: sizeInfo.familyCapacityInfo.totalSize
    };
  }
  
  return {
    personal: sizeInfo.cloudCapacityInfo.totalSize,
    family: sizeInfo.familyCapacityInfo.totalSize
  };
}

// 推送模块
async function sendNotification(content) {
  const channels = [];
  
  if (process.env.SERVERCHAN_KEY) {
    channels.push(sendServerChan(content));
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    channels.push(sendTelegram(content));
  }
  
  return Promise.allSettled(channels);
}

// 主流程
async function main() {
  const accounts = JSON.parse(process.env.CLOUD_ACCOUNTS || '[]');
  
  for (const [index, account] of accounts.entries()) {
    try {
      const client = new CloudClient(account.user, account.pwd);
      await client.login();
      
      const isFirstAccount = index === 0;
      const initialSize = await collectCapacityData(client, isFirstAccount);
      
      await executeTasks(client);
      
      const currentSize = await collectCapacityData(client, false);
      
      // 累计统计
      if (isFirstAccount) {
        capacityStats.totalAdded.personal = currentSize.personal - initialSize.personal;
        capacityStats.firstAccount.current = currentSize;
      }
      
      capacityStats.totalAdded.family += currentSize.family - initialSize.family;
      
    } catch (error) {
      logger.error(`账户处理失败: ${error.message}`);
    }
  }

  // 生成报告
  const report = [
    buildTable(capacityStats.firstAccount),
    '\n▎容量增量统计',
    `  个人云：+${formatCapacity(capacityStats.totalAdded.personal, 'M')}（仅首账号）`,
    `  家庭云：+${formatCapacity(capacityStats.totalAdded.family, 'M')}（累计所有账号）`
  ].join('\n');

  logger.info(report);
  await sendNotification(report);
}

// 执行入口
(async () => {
  try {
    await main();
  } finally {
    recording.erase();
  }
})();
