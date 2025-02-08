const superagent = require('superagent');

// WxPusher配置
const appToken = 'YOUR_APP_TOKEN';
const uid = 'YOUR_UID';

// 模拟账户签到数据
const accountData = [
    {
        accountNumber: '1',
        personal: '个人签到  500M',
        family: '家庭签到  400M'
    },
    {
        accountNumber: '12',
        personal: '个人签到    0M',
        family: '❌ 家庭: 家庭任务失败：网络连接超时'
    },
    {
        accountNumber: '3',
        personal: '个人签到  400M',
        family: '家庭签到  0M'
    }
];

// 容量汇总数据
const summaryData = {
    accountName: '136****6666',
    personalGB: '500.00',
    personalAdd: '0',
    familyGB: '100.00',
    familyAdd: '0',
    successCount: '2'
};

// 构建推送内容
let content = '';
const line = '════════════════════════════════════';
content += `${line}\n**天翼云盘任务报告**\n${line}\n`;
accountData.forEach(account => {
    const accountNumber = `🆔 账户 ${account.accountNumber}`.padEnd(10);
    const personalInfo = account.personal.padEnd(15);
    const familyInfo = account.family;
    content += `${accountNumber}: ${personalInfo} ${familyInfo}\n`;
});

content += `\n${line}\n**  容量汇总与变动**\n${line}\n`;
content += `  **🆔 账户名称:** ${summaryData.accountName}\n`;
content += `  **📋 个人云容量:** ${summaryData.personalGB}G（本次 +${summaryData.personalAdd}M）\n`;
content += `  **🏠 家庭云容量:** ${summaryData.familyGB}G（家庭云合计 +${summaryData.familyAdd}M）\n`;
content += `  **✅ 家庭云成功执行个数:** ${summaryData.successCount}\n`;

const title = '════════════════════════════════════\n**天翼云签到报告**\n════════════════════════════════════';

superagent.post('https://wxpusher.zjiecode.com/api/send/message')
 .send({
        appToken: appToken,
        contentType: 3,
        summary: title,
        content: content,
        uids: [uid]
    })
 .then(res => {
        console.log('推送成功', res.body);
    })
 .catch(err => {
        console.error('推送失败', err);
    });

