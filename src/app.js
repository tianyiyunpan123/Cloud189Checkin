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

const pushConfig = {
    serverChan: require("./push/serverChan"),
    telegramBot: require("./push/telegramBot"),
    wecomBot: require("./push/wecomBot"),
    wxpush: require("./push/wxPusher")
};

const mask = (s, start = 3, end = 7) =>
    s.split("").fill("*", start, end).join("");

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 定义颜色常量
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    underscore: '\x1b[4m',
    blink: '\x1b[5m',
    reverse: '\x1b[7m',
    hidden: '\x1b[8m',
    fg: {
        black: '\x1b[30m',
        red: '\x1b[31m',
        green: '\x1b[32m',
        yellow: '\x1b[33m',
        blue: '\x1b[34m',
        magenta: '\x1b[35m',
        cyan: '\x1b[36m',
        white: '\x1b[37m',
        crimson: '\x1b[38m'
    },
    bg: {
        black: '\x1b[40m',
        red: '\x1b[41m',
        green: '\x1b[42m',
        yellow: '\x1b[43m',
        blue: '\x1b[44m',
        magenta: '\x1b[45m',
        cyan: '\x1b[46m',
        white: '\x1b[47m',
        crimson: '\x1b[48m'
    }
};

// ==================== 核心任务逻辑 ====================
const doTask = async (cloudClient) => {
    const result = [];
    try {
        const res = await cloudClient.userSign();
        const personalAdd = res.netdiskBonus;
        const status = res.isSign? "已签到" : "签到成功";
        const msg = `▸ ${status}，获得 ${personalAdd}M 空间`;
        result.push(colors.fg.green + msg + colors.reset);
        return { result, personalAdd };
    } catch (e) {
        const msg = `⚠ 任务失败：${e.message}`;
        result.push(colors.fg.red + msg + colors.reset);
        return { result, personalAdd: 0 };
    }
};

const doFamilyTask = async (cloudClient) => {
    const results = [];
    let familyAdd = 0;
    let familySuccessCount = 0;
    try {
        const { familyInfoResp } = await cloudClient.getFamilyList();
        if (familyInfoResp?.length) {
            const { familyId } = familyInfoResp[0];
            const res = await cloudClient.familyUserSign(165515815004439);
            const bonus = res.bonusSpace || 0;
            const status = res.signStatus? "已签到" : "签到成功";
            const msg = `▹ 家庭云 ${status}，获得 ${bonus}M 空间`;
            results.push(colors.fg.green + msg + colors.reset);
            familyAdd += bonus;
            familySuccessCount = 1;
        }
    } catch (e) {
        const msg = `⚠ 家庭任务失败：${e.message}`;
        results.push(colors.fg.red + msg + colors.reset);
    }
    return { results, familyAdd, familySuccessCount };
};

// ==================== 推送系统 ====================
async function sendNotifications(title, content) {
    // 青龙面板通知
    if (typeof $!== 'undefined' && $.notify) {
        await $.notify(title, content);
    }

    const { serverChan, telegramBot, wecomBot, wxpush } = pushConfig;

    // 去除ANSI转义序列，确保微信推送正常显示
    const cleanContent = content.replace(/\x1b\[\d+m/g, '');

    // ServerChan推送
    if (serverChan.sendKey) {
        superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
         .send({ title, desp: cleanContent })
         .catch(e => logger.error('ServerChan推送失败:', e));
    }

    // Telegram推送
    if (telegramBot.botToken && telegramBot.chatId) {
        superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
         .send({
                chat_id: telegramBot.chatId,
                text: `**${title}**\n\`\`\`\n${cleanContent}\n\`\`\``,
                parse_mode: 'Markdown'
            })
         .catch(e => logger.error('Telegram推送失败:', e));
    }

    // 企业微信推送
    if (wecomBot.key) {
        superagent.post(`https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${wecomBot.key}`)
         .send({
                msgtype: "markdown",
                markdown: {
                    content: `**${title}**\n\`\`\`\n${cleanContent}\n\`\`\``
                }
            })
         .catch(e => logger.error('企业微信推送失败:', e));
    }

    // WxPusher推送
    if (wxpush.appToken && wxpush.uid) {
        superagent.post("https://wxpusher.zjiecode.com/api/send/message")
         .send({
                appToken: wxpush.appToken,
                contentType: 3,
                summary: title,
                content: `**${title}**\n\`\`\`\n${cleanContent}\n\`\`\``,
                uids: [wxpush.uid]
            })
         .catch(e => logger.error('WxPusher推送失败:', e));
    }
}

// ==================== 主执行流程 ====================
(async () => {
    let firstAccountData = null;
    let totalFamilyAdd = 0;
    let totalFamilySuccessCount = 0;
    const reportLines = [colors.bright + '══════════ 天翼云盘任务报告 ══════════' + colors.reset];

    try {
        for (const [index, account] of accounts.entries()) {
            const { userName, password } = account;
            if (!userName ||!password) continue;

            const userMask = mask(userName);
            const accountLog = [colors.bright + `✦ 账户 ${index + 1} │ ${userMask}` + colors.reset];

            try {
                const client = new CloudClient(userName, password);
                await client.login();

                // 执行任务
                const [taskRes, familyRes] = await Promise.all([
                    doTask(client),
                    doFamilyTask(client)
                ]);

                // 记录日志
                accountLog.push(...taskRes.result,...familyRes.results);
                totalFamilyAdd += familyRes.familyAdd;
                totalFamilySuccessCount += familyRes.familySuccessCount;

                // 记录首个账号数据
                if (index === 0) {
                    const sizeInfo = await client.getUserSizeInfo();
                    firstAccountData = {
                        user: userMask,
                        personalGB: sizeInfo.cloudCapacityInfo.totalSize / 1024 ** 3,
                        familyGB: sizeInfo.familyCapacityInfo.totalSize / 1024 ** 3,
                        personalAdd: taskRes.personalAdd
                    };
                }

                // accountLog.push(colors.dim + '├' + '─'.repeat(35) + colors.reset); // 去除线条

            } catch (e) {
                const msg = `⚠ 账户异常：${e.message}`;
                accountLog.push(colors.fg.red + msg + colors.reset);
            }
            reportLines.push(...accountLog);
        }

        // ==================== 生成报表 ====================
        if (firstAccountData) {
            reportLines.push(
                colors.bright + '\n════════════ 容量汇总 ════════════' + colors.reset,
                `账户名称: ${firstAccountData.user}`,
                `个人云容量: ${firstAccountData.personalGB.toFixed(2)}G`,
                `家庭云容量: ${firstAccountData.familyGB.toFixed(2)}G`,
                colors.bright + '\n════════════ 容量变动 ════════════' + colors.reset,
                `  ➤ 首个账号个人云: +${firstAccountData.personalAdd}M`,
                `  ➤ 全部家庭云合计: +${totalFamilyAdd}M`,
                `  ➤ 家庭云成功执行个数: ${totalFamilySuccessCount}`,
                colors.bright + '════════════════════════════════════' + colors.reset
            );
        }

    } catch (e) {
        const msg = `⚠ 系统异常：${e.message}`;
        reportLines.push(colors.fg.red + msg + colors.reset);
    } finally {
        const finalReport = reportLines.join('\n');
        console.log(finalReport);
        await sendNotifications('☁️ 天翼云签到报告', finalReport);
        recording.erase();
    }
})();

