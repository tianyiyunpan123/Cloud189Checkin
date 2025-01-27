const { CloudClient } = require("cloud189-sdk");

// 增强版敏感信息掩码（显示前3后4）
const mask = (s, visibleStart = 3, visibleEnd = 4) => {
  if (!s || s.length <= visibleStart + visibleEnd) return s;
  return `${s.slice(0, visibleStart)}${'*'.repeat(s.length - visibleStart - visibleEnd)}${s.slice(-visibleEnd)}`;
};

// 容量统计相关
let totalPersonalGB = 0;
let totalFamilyGB = 0;
const capacityDetails = [];
const message = [];

// 抽奖结果处理
const buildTaskResult = (res, index) => {
  if (!res) return `第${index}次抽奖失败：无响应`;
  return res.errorCode === "User_Not_Chance" 
    ? `第${index}次抽奖失败，次数不足` 
    : `第${index}次抽奖成功，获得 ${res.prizeName || '未知奖励'}`;
};

// 延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 个人任务（签到+单次抽奖）
const doPersonalTask = async cloudClient => {
  const result = [];
  
  try {
    // 个人签到
    const signRes = await cloudClient.userSign();
    result.push(`${signRes.isSign ? '已签到' : '签到成功'}，获得 ${signRes.netdiskBonus}M 空间`);
  } catch (e) {
    result.push(`❌ 个人签到失败：${e.message}`);
  }

  // 仅保留第一次抽奖
  try {
    await delay(5000); // 保持5秒间隔
    const res = await cloudClient.taskSign();
    result.push(buildTaskResult(res, 1));
  } catch (e) {
    result.push(`第1次抽奖异常：${e.message}`);
  }

  return result;
};

// 家庭空间任务
const doFamilyTask = async cloudClient => {
  const result = [];
  try {
    const { familyInfoResp } = await cloudClient.getFamilyList();
    
    if (familyInfoResp?.length) {
      for (const { familyId } of familyInfoResp) {
        try {
          await delay(3000);
          const validFamilyId = familyId?.toString(165515815004439) || '';
          const res = await cloudClient.familyUserSign(165515815004439);
          const shortId = validFamilyId.slice(-6);
          result.push(`家庭空间${shortId}：${res.signStatus ? '已签到' : '签到成功'}，获得 ${res.bonusSpace}M 空间`);
        } catch (e) {
          result.push(`⚠️ 家庭空间 ${familyId} 签到失败：${e.message}`);
        }
      }
    } else {
      result.push('未找到家庭空间信息');
    }
  } catch (e) {
    result.push(`❌ 家庭空间查询失败：${e.message}`);
  }
  return result;
};

// 账号主流程
async function main(userName, password) {
  const maskedName = mask(userName);
  const accountLog = [`\n🔔 账号 ${maskedName}`];
  
  try {
    const cloudClient = new CloudClient(userName, password);
    
    if (!await cloudClient.login()) {
      accountLog.push('❌ 登录失败');
      message.push(...accountLog);
      return;
    }

    // 执行任务流程
    const [personalResult, familyResult] = await Promise.all([
      doPersonalTask(cloudClient),
      doFamilyTask(cloudClient)
    ]);
    accountLog.push(...personalResult, ...familyResult);

    // 容量统计
    try {
      const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
      const personalGB = (cloudCapacityInfo?.totalSize || 0) / 1024 ** 3;
      const familyGB = (familyCapacityInfo?.totalSize || 0) / 1024 ** 3;

      totalPersonalGB += personalGB;
      totalFamilyGB += familyGB;
      capacityDetails.push({ maskedName, personalGB, familyGB });
      
      accountLog.push(`📦 当前容量：个人 ${personalGB.toFixed(2)}G | 家庭 ${familyGB.toFixed(2)}G`);
    } catch (e) {
      accountLog.push(`❌ 容量查询失败：${e.message}`);
    }

  } catch (e) {
    accountLog.push(`⚠️ 执行异常：${e.message}`);
  } finally {
    accountLog.push('✅ 执行完毕');
    message.push(accountLog.join('\n   ├─ '));
  }
}

// 程序入口
(async () => {
  try {
    const c189Accounts = process.env.CLOUD_189?.split('\n')?.filter(Boolean) || [];
    
    if (!c189Accounts.length) {
      message.push('❌ 未配置环境变量 CLOUD_189');
      return;
    }

    message.push('=== 天翼云盘自动签到开始 ===');
    
    // 顺序处理所有账号
    for (const account of c189Accounts) {
      const sepIndex = account.indexOf('|');
      if (sepIndex === -1) {
        message.push(`❌ 无效账号格式：${mask(account)}`);
        continue;
      }
      
      const [user, pass] = [account.slice(0, sepIndex).trim(), account.slice(sepIndex + 1).trim()];
      if (!user || !pass) {
        message.push(`❌ 无效账号凭证：${mask(account)}`);
        continue;
      }

      await main(user, pass);
      await delay(8000); // 账号间间隔8秒
    }

    // 生成专业汇总报告
    if (capacityDetails.length) {
      message.push('\n📊 ==== 容量汇总报告 ====');
      message.push('账号'.padEnd(18) + '个人容量'.padStart(12) + '家庭容量'.padStart(12));
      message.push('─'.repeat(42));
      
      capacityDetails.forEach(({ maskedName, personalGB, familyGB }) => {
        message.push(
          `${maskedName.padEnd(20)}` +
          `${personalGB.toFixed(2).padStart(10)}G` +
          `${familyGB.toFixed(2).padStart(12)}G`
        );
      });
      
      message.push('─'.repeat(42));
      message.push(
        '总计'.padEnd(20) +
        `${totalPersonalGB.toFixed(2).padStart(10)}G` +
        `${totalFamilyGB.toFixed(2).padStart(12)}G`
      );
    }

    message.push('\n=== 任务执行完成 ===');

  } catch (e) {
    message.push(`⚠️ 全局异常：${e.message}`);
  } finally {
    console.log(message.join('\n'));
    try {
      if (typeof QLAPI !== 'undefined' && QLAPI.notify) {
        await QLAPI.notify('天翼云盘签到报告', message.join('\n'));
      }
    } catch (e) {
      console.error('通知发送失败：', e.message);
    }
  }
})();
