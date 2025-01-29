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
// ... 其他推送模块引入保持不变...

// ================== 新增数据收集结构 ==================
const capacityData = {
  personal: {
    original: 0,   // 个人云原始容量(GB)
    added: 0       // 个人云新增容量(MB)
  },
  family: {
    original: 0,   // 家庭云原始容量(GB)
    added: 0       // 家庭云新增总容量(MB)
  }
};

// ================== 修改后的任务函数 ==================
const doTask = async (cloudClient) => {
  const result = [];
  const res1 = await cloudClient.userSign();
  const addedPersonal = parseInt(res1.netdiskBonus) || 0; // 捕获个人新增容量
  result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得${addedPersonal}M空间`);
  
  await delay(5000);
  // ... 其他任务保持不变...

  return { result, addedPersonal };
};

const doFamilyTask = async (cloudClient) => {
  const { familyInfoResp } = await cloudClient.getFamilyList();
  const result = [];
  let addedFamily = 0;
  
  if (familyInfoResp) {
    for (const family of familyInfoResp) {
      const res = await cloudClient.familyUserSign(family.165515815004439);
      const space = parseInt(res.bonusSpace) || 0;
      addedFamily += space;
      result.push(`家庭云获得${space}M空间`);
    }
  }
  
  return { result, addedFamily };
};

// ================== 修改后的主流程 ==================
async function main() {
  let firstAccountProcessed = false;
  
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    const { userName, password } = account;
    
    if (!userName || !password) continue;
    
    const maskedName = mask(userName, 3, 7);
    logger.info(`\n======== 开始处理账号 ${i + 1} [${maskedName}] ========`);
    
    try {
      const cloudClient = new CloudClient(userName, password);
      await cloudClient.login();

      // 处理个人任务
      const { result, addedPersonal } = await doTask(cloudClient);
      
      // 处理家庭任务
      const { result: familyResult, addedFamily } = await doFamilyTask(cloudClient);
      
      // 记录首个账号的原始容量
      if (!firstAccountProcessed) {
        const sizeInfo = await cloudClient.getUserSizeInfo();
        capacityData.personal.original = sizeInfo.cloudCapacityInfo.totalSize / 1024 ** 3;
        capacityData.family.original = sizeInfo.familyCapacityInfo.totalSize / 1024 ** 3;
        firstAccountProcessed = true;
      }

      // 累计容量数据
      capacityData.personal.added += addedPersonal;
      capacityData.family.added += addedFamily;

      // 记录日志
      result.concat(familyResult).forEach(msg => logger.info(msg));
      
    } catch (e) {
      logger.error(`处理失败: ${e.message}`);
    } finally {
      logger.info(`======== 结束处理账号 ${i + 1} ========\n`);
    }
  }
}

// ================== 生成表格的函数 ==================
function generateCapacityTable() {
  const totalPersonal = capacityData.personal.original + (capacityData.personal.added / 1024);
  const totalFamily = capacityData.family.original + (capacityData.family.added / 1024);

  return `
┌──────────────┬───────────────┬───────────────┐
│  容量类型    │  个人云       │  家庭云       │
├──────────────┼───────────────┼───────────────┤
│ 原始容量(GB) │ ${capacityData.personal.original.toFixed(2).padStart(12)} │ ${capacityData.family.original.toFixed(2).padStart(13)} │
├──────────────┼───────────────┼───────────────┤
│ 新增容量(MB) │ ${capacityData.personal.added.toString().padStart(12)} │ ${capacityData.family.added.toString().padStart(13)} │
├──────────────┼───────────────┼───────────────┤
│ 当前总计(GB) │ ${totalPersonal.toFixed(2).padStart(12)} │ ${totalFamily.toFixed(2).padStart(13)} │
└──────────────┴───────────────┴───────────────┘
  `.trim();
}

// ================== 修改后的推送入口 ==================
(async () => {
  try {
    await main();
  } finally {
    const events = recording.replay();
    
    // 构建带序号的分隔格式
    const content = events.map((e, i) => {
      if (e.data[0].includes("开始处理账号")) {
        return `\n${e.data[0]}\n${'-'.repeat(35)}`;
      }
      return `[${i}] ${e.data[0]}`;
    }).join('\n');

    // 添加容量汇总表格
    const fullContent = `${content}\n\n容量汇总：\n${generateCapacityTable()}`;
    
    push("天翼云盘任务简报", fullContent);
    recording.erase();
  }
})();
