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

// ==================== 核心任务逻辑 ====================
const doTask = async (cloudClient) => {
    const result = [];
    try {
        const res = await cloudClient.userSign();
        const personalAdd = res.netdiskBonus;
        const status = res.isSign? "已签到" : "签到成功";
        const msg = `📋 个人签到 ${personalAdd.toString().padStart(4)}M`;
        result.push(msg);
        return { result, personalAdd };
    } catch (e) {
        const msg = `❌ 个人任务失败：${e.message}`;
        result.push(msg);
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
            const msg = `🏠 家庭签到${bonus.toString().padStart(4)}M`;
            results.push(msg);
            familyAdd += bonus;
            familySuccessCount = 1;
        }
    } catch (e) {
        const msg = `❌ 家庭: 家庭任务失败：${e.message}`;
        results.push(msg);
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

    // ServerChan推送
    if (serverChan.sendKey) {
        superagent.post(`https://sctapi.ftqq.com/${serverChan.sendKey}.send`)
            .send({ title, desp: content })
            .catch(e => logger.error('ServerChan推送失败:', e));
    }

    // Telegram推送
    if (telegramBot.botToken && telegramBot.chatId) {
        superagent.post(`https://api.telegram.org/bot${telegramBot.botToken}/sendMessage`)
            .send({
                chat_id: telegramBot.chatId,
                text: `**${title}**\n\`\`\`\n${content}\n\`\`\``,
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
                    content: `**${title}**\n\`\`\`\n${content}\n\`\`\``
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
                content: `**${title}**\n\`\`\`\n${content}\n\`\`\``,
                uids: [wxpush.uid]
            })
            .catch(e => logger.error('WxPusher推送失败:', e));
    }
}

// ==================== 主执行流程 ====================
(async () => {
    let lastAccountData = null;
    let totalFamilyAdd = 0;
    let totalFamilySuccessCount = 0;
    const reportLines = ['🗄️🗄️🗄️ 天翼云盘任务报告 🗄️🗄️🗄️'];

    try {
        for (const [index, account] of accounts.entries()) {
            const { userName, password } = account;
            if (!userName ||!password) continue;

            const userMask = mask(userName);
            try {
                const client = new CloudClient(userName, password);
                await client.login();

                // 执行任务
                const [taskRes, familyRes] = await Promise.all([
                    doTask(client),
                    doFamilyTask(client)
                ]);

                // 记录日志
                const personalInfo = taskRes.result[0].padEnd(20);
                const familyInfo = familyRes.results[0]? familyRes.results[0].padEnd(20) : '❌ 家庭: 无家庭云任务';
                const accountLog = `🆔 账户 ${index + 1}: ${userMask}  |  ${personalInfo} |  ${familyInfo}`;
                reportLines.push(accountLog);

                totalFamilyAdd += familyRes.familyAdd;
                totalFamilySuccessCount += familyRes.familySuccessCount;

                // 记录最后一个账号数据
                if (index === accounts.length - 1) {
                    const sizeInfo = await client.getUserSizeInfo();
                    lastAccountData = {
                        user: userMask,
                        personalGB: sizeInfo.cloudCapacityInfo.totalSize / 1024 ** 3,
                        familyGB: sizeInfo.familyCapacityInfo.totalSize / 1024 ** 3,
                        personalAdd: taskRes.personalAdd
                    };
                }
            } catch (e) {
                const msg = `❌ 账户异常：${e.message}`;
                reportLines.push(`🆔 账户 ${index + 1}: ${userMask}  |  ${msg}`);
            }
        }

        // ==================== 生成报表 ====================
        if (lastAccountData) {
            reportLines.push(
                '\n📊📊📊 容量汇总与变动 📊📊📊',
                `  🆔 账户名称: ${lastAccountData.user}`,
                `  📋 个人云容量: ${lastAccountData.personalGB.toFixed(2)}G（本次 +${lastAccountData.personalAdd}M）`,
                `  🏠 家庭云容量: ${lastAccountData.familyGB.toFixed(2)}G（全部家庭云合计 +${totalFamilyAdd}M）`,
                `  ✅ 家庭云成功执行个数: ${totalFamilySuccessCount}`,
                '🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️🗄️'
            );
        }

    } catch (e) {
        const msg = `❌ 系统异常：${e.message}`;
        reportLines.push(msg);
    } finally {
        const finalReport = reportLines.join('\n');
        console.log(finalReport);
        await sendNotifications('📝 天翼云签到报告', finalReport);
        recording.erase();
    }
})();
