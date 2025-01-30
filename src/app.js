/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const recording = require("log4js/lib/appenders/recording");
const { exec } = require("child_process");
const superagent = require("superagent");
const { CloudClient } = require("cloud189-sdk");

// 日志配置
log4js.configure({
  appenders: {
    vcr: { type: "recording" },
    out: { type: "console" },
    file: { 
      type: "dateFile", 
      filename: "logs/app.log",
      pattern: ".yyyy-MM-dd"
    }
  },
  categories: { 
    default: { 
      appenders: ["vcr", "out", "file"], 
      level: process.env.NODE_ENV === "production" ? "info" : "debug" 
    }
  }
});

const logger = log4js.getLogger();

// 全局错误处理
process.on("uncaughtException", (err) => {
  logger.fatal(`UNCAUGHT EXCEPTION: ${err.stack}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`UNHANDLED REJECTION: ${reason}`);
});

// 增强云客户端
class EnhancedCloudClient extends CloudClient {
  constructor(username, password) {
    super(username, password, {
      retryConfig: {
        maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
        retryDelay: parseInt(process.env.RETRY_DELAY) || 5000,
        retryCondition: (error) => 
          error.code === "ECONNRESET" || 
          error.statusCode >= 500
      }
    });
  }

  async validateToken() {
    try {
      await this.getUserInfo();
      return true;
    } catch {
      return false;
    }
  }
}

// 安全执行模块
async function safeExec(command, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          if (n > 0) {
            logger.warn(`Command failed, retries left: ${n}`);
            setTimeout(() => attempt(n - 1), 2000);
          } else {
            reject(new Error(`Final failure: ${stderr}`));
          }
        } else {
          resolve(stdout.trim());
        }
      });
    };
    attempt(retries);
  });
}

// 容量追踪器
const capacityTracker = {
  firstAccount: null,
  totalFamilyBonus: 0,

  init(cloudData) {
    if (!this.firstAccount) {
      this.firstAccount = {
        personal: {
          original: cloudData.personal / 1024 ** 3,
          bonus: 0
        },
        family: {
          original: cloudData.family / 1024 ** 3,
          bonus: 0
        }
      };
    }
  },

  addPersonalBonus(bonus) {
    if (this.firstAccount) {
      this.firstAccount.personal.bonus += bonus;
    }
  },

  addFamilyBonus(bonus) {
    this.totalFamilyBonus += bonus;
    if (this.firstAccount) {
      this.firstAccount.family.bonus = this.totalFamilyBonus;
    }
  },

  generateWechatTable() {
    const p = this.firstAccount.personal;
    const f = this.firstAccount.family;
    
    return [
      "📊 容量变动报告",
      "|  类型  |  原容量  | 本次新增 |  当前总量  |",
      "|:------:|:--------:|:--------:|:----------:|",
      `| 个人云 | ${p.original.toFixed(2)}GB | ${p.bonus}M | ${(p.original + p.bonus/1024).toFixed(2)}GB |`,
      `| 家庭云 | ${f.original.toFixed(2)}GB | ${f.bonus}M | ${(f.original + f.bonus/1024).toFixed(2)}GB |`,
      "\n📌 注：家庭云数据为所有账号累计值"
    ].join("\n");
  }
};

// 推送服务
const notifier = {
  async sendAll(content) {
    const title = "☁️ 天翼云盘执行报告";
    await Promise.allSettled([
      this._sendWecom(title, content),
      this._sendWxPusher(title, content)
    ]);
  },

  async _sendWecom(title, content) {
    if (!process.env.WECOM_KEY) return;
    
    try {
      await superagent
        .post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${process.env.WECOM_KEY}`)
        .send({
          msgtype: "markdown",
          markdown: {
            content: `**${title}**\n${content}`
          }
        });
    } catch (err) {
      logger.error("企业微信推送失败:", err.message);
    }
  },

  async _sendWxPusher(title, content) {
    if (!process.env.WXPUSHER_TOKEN || !process.env.WXPUSHER_UID) return;

    try {
      await superagent
        .post("https://wxpusher.zjiecode.com/api/send/message")
        .send({
          appToken: process.env.WXPUSHER_TOKEN,
          contentType: 3,  // Markdown类型
          summary: title,
          content,
          uids: [process.env.WXPUSHER_UID]
        });
    } catch (err) {
      logger.error("微信推送失败:", err.message);
    }
  }
};

// 主业务流程
async function execute() {
  try {
    // 环境预检
    await safeExec("curl --version");
    
    // 处理首个账号
    const mainAccount = {
      userName: process.env.FIRST_ACCOUNT_USER,
      password: process.env.FIRST_ACCOUNT_PASS
    };

    const client = new EnhancedCloudClient(mainAccount.userName, mainAccount.password);
    
    // 账号验证
    const isValid = await client.validateToken();
    if (!isValid) throw new Error("主账号凭证失效");

    // 获取容量基准
    const sizeInfo = await client.getUserSizeInfo();
    capacityTracker.init({
      personal: sizeInfo.cloudCapacityInfo.totalSize,
      family: sizeInfo.familyCapacityInfo.totalSize
    });

    // 执行签到任务
    const personalRes = await client.userSign();
    capacityTracker.addPersonalBonus(personalRes.netdiskBonus);

    // 家庭任务
    const { familyInfoResp } = await client.getFamilyList();
    if (familyInfoResp) {
      for (const family of familyInfoResp) {
        const res = await client.familyUserSign(family.165515815004439);
        capacityTracker.addFamilyBonus(res.bonusSpace);
      }
    }

    // 生成报告
    const report = [
      "✅ 任务执行成功",
      capacityTracker.generateWechatTable(),
      `🕒 执行时间: ${new Date().toLocaleString()}`
    ].join("\n\n");

    // 发送通知
    await notifier.sendAll(report);
    logger.info("流程执行完成");

  } catch (err) {
    logger.error("主流程异常:", err.stack);
    await notifier.sendAll(`❌ 任务执行失败: ${err.message}`);
    process.exit(1);
  }
}

// 健康检查
function checkEnv() {
  const requiredVars = [
    'FIRST_ACCOUNT_USER', 
    'FIRST_ACCOUNT_PASS',
    'WXPUSHER_TOKEN',
    'WXPUSHER_UID'
  ];

  const missing = requiredVars.filter(v => !process.env[v]);
  if (missing.length > 0) {
    logger.fatal("缺失环境变量:", missing.join(", "));
    process.exit(1);
  }
}

// 启动入口
(async () => {
  checkEnv();
  await execute();
  recording.erase();
})();
