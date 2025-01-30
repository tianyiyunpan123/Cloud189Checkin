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

// 微信推送配置
const { wxpush } = require("./push/config");

// 智能掩码处理
const mask = (s) => {
  if (s.length <= 4) return s[0] + '*'.repeat(s.length - 2) + s.slice(-1);
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
};

// 系统延迟
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 微信消息推送
async function wechatPush(content) {
  if (!wxpush.appToken || !wxpush.uid) return;
  
  try {
    await superagent.post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: wxpush.appToken,
        contentType: 3,  // 使用Markdown格式
        content: `
          ## 🗂️ 天翼云盘容量报告  
          ${content}
        `,
        uids: [wxpush.uid]
      });
    logger.info("微信推送成功");
  } catch (e) {
    logger.error("微信推送失败:", e);
  }
}

// 新版任务执行器
class TaskExecutor {
  constructor(client) {
    this.client = client;
    this.personalAdd = 0;
    this.familyAdd = 0;
    this.logs = [];
  }

  async execute() {
    try {
      // 每日签到
      const signRes = await this.client.userSign();
      this.personalAdd = signRes.netdiskBonus || 0;
      this.logs.push(`${signRes.isSign ? "🔄" : "✅"} 个人签到 +${this.personalAdd}M`);
      await delay(1500);

      // 家庭任务
      const { familyInfoResp } = await this.client.getFamilyList();
      if (familyInfoResp) {
        for (const family of familyInfoResp) {
          const res = await this.client.familyUserSign(family.165515815004439);
          this.familyAdd += res.bonusSpace || 0;
          this.logs.push(`🏠 家庭签到 +${res.bonusSpace}M`);
          await delay(1000);
        }
      }
    } catch (e) {
      this.logs.push(`❌ 错误: ${e.message}`);
    }
    return this;
  }
}

// 主处理流程
async function main() {
  let firstAccount = null;
  let totalFamilyAdd = 0;

  for (const [index, account] of accounts.entries()) {
    const { userName, password } = account;
    if (!userName || !password) continue;

    recording.start();
    const maskedName = mask(userName);
    logger.info(`\n🚀 处理账户 ${index + 1}/${accounts.length}: ${maskedName}`);

    try {
      // 初始化客户端
      const client = new CloudClient(userName, password);
      await client.login();

      // 获取原始容量
      const { cloudCapacityInfo, familyCapacityInfo } = await client.getUserSizeInfo();
      const originalPersonal = cloudCapacityInfo.totalSize / (1024 ** 3);
      const originalFamily = familyCapacityInfo.totalSize / (1024 ** 3);

      // 执行任务
      const executor = await new TaskExecutor(client).execute();
      logger.info(executor.logs.join(" | "));

      // 记录首个账户数据
      if (index === 0) {
        firstAccount = {
          name: maskedName,
          original: {
            personal: originalPersonal,
            family: originalFamily
          },
          add: {
            personal: executor.personalAdd,
            family: executor.familyAdd
          }
        };
      }

      // 累计所有账户的家庭新增
      totalFamilyAdd += executor.familyAdd;

    } catch (e) {
      logger.error(`账户处理失败: ${e.message}`);
    } finally {
      recording.erase();
    }
  }

  // 生成专业报告
  if (firstAccount) {
    // 计算总计
    const finalPersonal = firstAccount.original.personal + (firstAccount.add.personal / 1024);
    const finalFamily = firstAccount.original.family + (totalFamilyAdd / 1024);

    // 构建专业表格
    const report = `
| 项目        | 个人空间               | 家庭空间               |
|-------------|------------------------|------------------------|
| 原容量      | ${firstAccount.original.personal.toFixed(2).padStart(6)} GB      | ${firstAccount.original.family.toFixed(2).padStart(6)} GB      |
| 本次新增    | ${firstAccount.add.personal.toString().padStart(6)} MB      | ${totalFamilyAdd.toString().padStart(6)} MB      |
| 当前总计    | ${finalPersonal.toFixed(2).padStart(6)} GB      | ${finalFamily.toFixed(2).padStart(6)} GB      |

🔖 统计说明：
1. 个人空间数据来自首个账户：${firstAccount.name}
2. 家庭空间新增累计所有账户签到结果
3. 转换率：1 GB = 1024 MB`.trim();

    logger.info("\n" + report);
    await wechatPush(`\`\`\`\n${report}\n\`\`\``);
  }
}

// 安全启动
(async () => {
  try {
    await main();
    logger.info("✅ 所有任务处理完成");
  } catch (e) {
    logger.error("‼️ 全局错误:", e);
    await wechatPush(`⚠️ 系统异常: ${e.message}`);
  }
})();
