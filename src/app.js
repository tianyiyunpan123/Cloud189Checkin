/* eslint-disable no-await-in-loop */
require("dotenv").config();
const log4js = require("log4js");
const { exec } = require("child_process");
const { CloudClient } = require("cloud189-sdk");
const superagent = require("superagent");
const accounts = require("../accounts");

// 日志配置
log4js.configure({
  appenders: {
    file: {
      type: "file",
      filename: "cloud189.log",
      maxLogSize: 10 * 1024 * 1024, // 10MB
      backups: 3
    },
    console: { type: "console" }
  },
  categories: {
    default: {
      appenders: ["file", "console"],
      level: process.env.NODE_ENV === "production" ? "info" : "debug"
    }
  }
});

const logger = log4js.getLogger("main");

// 安全执行子进程（带重试和超时）
async function safeExec(command, options = {}) {
  const maxRetries = options.retries || 3;
  const timeout = options.timeout || 30000;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      logger.debug(`执行命令: ${command} (尝试 ${attempt}/${maxRetries})`);
      
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`命令执行超时 (${timeout}ms)`));
        }, timeout);

        const child = exec(command, {
          ...options,
          env: { ...process.env, ...options.env }
        }, (error, stdout, stderr) => {
          clearTimeout(timer);
          if (error) {
            error.stderr = stderr;
            return reject(error);
          }
          resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        });

        // 实时日志输出
        child.stdout.on("data", data => {
          data.toString().split('\n').forEach(line => {
            if (line) logger.debug(`[子进程输出] ${line}`);
          });
        });

        child.stderr.on("data", data => {
          data.toString().split('\n').forEach(line => {
            if (line) logger.error(`[子进程错误] ${line}`);
          });
        });
      });
    } catch (error) {
      logger.error(`尝试 ${attempt} 失败: ${error.message}`);
      if (attempt === maxRetries) throw error;
      
      await new Promise(res => setTimeout(res, 2000 ** attempt));
      attempt++;
    }
  }
}

// 增强登录流程
async function safeLogin(client) {
  try {
    await client.login();
    return true;
  } catch (error) {
    if (error.message.includes("CAPTCHA")) {
      logger.warn("检测到验证码要求，尝试自动处理...");
      
      // 执行验证码处理脚本
      await safeExec("python3 scripts/captcha_solver.py", {
        cwd: __dirname,
        env: { 
          PHANTOMJS_PATH: process.env.PHANTOMJS_PATH,
          DEBUG_MODE: process.env.DEBUG_MODE 
        },
        retries: 2
      });
      
      logger.info("验证码处理完成，重试登录...");
      return safeLogin(client);
    }
    throw error;
  }
}

// 微信推送模块
async function wechatPush(content) {
  if (!process.env.WXPUSHER_TOKEN || !process.env.WXPUSHER_UID) return;

  try {
    const res = await superagent
      .post("https://wxpusher.zjiecode.com/api/send/message")
      .send({
        appToken: process.env.WXPUSHER_TOKEN,
        contentType: 3, // Markdown格式
        content: `## 🗂️ 天翼云盘执行报告\n\`\`\`\n${content}\n\`\`\``,
        uids: [process.env.WXPUSHER_UID]
      });

    if (res.body.code === 1000) {
      logger.info("微信推送成功");
    } else {
      logger.warn("微信推送异常:", res.body.msg);
    }
  } catch (error) {
    logger.error("微信推送失败:", error.message);
  }
}

// 核心任务执行类
class CloudTaskExecutor {
  constructor(username, password) {
    this.client = new CloudClient(username, password);
    this.maskedName = this.maskUsername(username);
    this.stats = {
      personal: { original: 0, added: 0 },
      family: { original: 0, added: 0 }
    };
  }

  maskUsername(username) {
    if (username.length <= 4) return username[0] + '*'.repeat(username.length - 1);
    return username.slice(0, 2) + '*'.repeat(username.length - 4) + username.slice(-2);
  }

  async initialize() {
    // 环境检查
    await safeExec("node --version", {
      validation: stdout => {
        const ver = stdout.match(/v(\d+\.\d+)/)[1];
        if (parseFloat(ver) < 14) throw new Error("需要Node.js 14+");
      }
    });

    await safeLogin(this.client);
    const capacity = await this.client.getUserSizeInfo();
    
    this.stats.personal.original = capacity.cloudCapacityInfo.totalSize / (1024 ** 3);
    this.stats.family.original = capacity.familyCapacityInfo.totalSize / (1024 ** 3);
  }

  async executeTasks() {
    try {
      // 每日签到
      const signRes = await this.client.userSign();
      this.stats.personal.added = signRes.netdiskBonus || 0;
      logger.info(`签到成功: +${this.stats.personal.added}M`);

      // 家庭任务
      const { familyInfoResp } = await this.client.getFamilyList();
      if (familyInfoResp) {
        for (const family of familyInfoResp) {
          const res = await this.client.familyUserSign(family.165515815004439);
          this.stats.family.added += res.bonusSpace || 0;
          await delay(1000);
        }
      }

      return true;
    } catch (error) {
      logger.error(`任务执行失败: ${error.message}`);
      return false;
    }
  }

  generateReport() {
    const totalPersonal = this.stats.personal.original + (this.stats.personal.added / 1024);
    const totalFamily = this.stats.family.original + (this.stats.family.added / 1024);

    return `
账户标识: ${this.maskedName}
┌──────────────┬───────────────┬───────────────┐
│  空间类型    │  原始容量     │  当前总量     │
├──────────────┼───────────────┼───────────────┤
│ 个人空间     │ ${this.stats.personal.original.toFixed(2).padStart(6)} GB  │ ${totalPersonal.toFixed(2).padStart(6)} GB  │
│ 家庭空间     │ ${this.stats.family.original.toFixed(2).padStart(6)} GB  │ ${totalFamily.toFixed(2).padStart(6)} GB  │
└──────────────┴───────────────┴───────────────┘
新增统计:
  • 个人空间: +${this.stats.personal.added} MB
  • 家庭空间: +${this.stats.family.added} MB
    `.trim();
  }
}

// 主执行流程
async function main() {
  try {
    if (!accounts.length) {
      logger.warn("未配置有效账户");
      return;
    }

    let totalFamilyAdded = 0;
    const reports = [];

    for (const [index, account] of accounts.entries()) {
      const executor = new CloudTaskExecutor(account.userName, account.password);
      
      try {
        logger.info(`\n=== 处理账户 ${index + 1}/${accounts.length} ===`);
        await executor.initialize();
        
        if (await executor.executeTasks()) {
          reports.push(executor.generateReport());
          
          // 累计家庭空间（所有账户）
          totalFamilyAdded += executor.stats.family.added;
          
          // 首个账户详细报告
          if (index === 0) {
            await wechatPush(executor.generateReport());
          }
        }
      } catch (error) {
        logger.error(`账户处理中断: ${error.message}`);
        await wechatPush(`❌ 账户处理异常: ${error.message}`);
      }
    }

    // 生成全局汇总报告
    if (reports.length) {
      const summary = `
=== 全局统计 ===
累计家庭空间新增: ${totalFamilyAdded} MB
等效容量增加: ${(totalFamilyAdded / 1024).toFixed(2)} GB

=== 详细报告 ===
${reports.join('\n\n')}
      `.trim();

      logger.info(summary);
      await wechatPush(summary);
    }

  } catch (error) {
    logger.fatal("主流程异常:", error);
    await wechatPush(`‼️ 系统级错误: ${error.message}`);
    process.exit(1);
  }
}

// 全局错误处理
process
  .on("unhandledRejection", reason => {
    logger.error("未处理的Promise拒绝:", reason);
    process.exitCode = 1;
  })
  .on("uncaughtException", error => {
    logger.fatal("未捕获的异常:", error);
    process.exitCode = 1;
  });

// 启动执行
main()
  .then(() => logger.info("所有任务处理完成"))
  .catch(() => process.exit(1));
