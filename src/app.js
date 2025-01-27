const { CloudClient } = require("cloud189-sdk");

// 敏感信息掩码工具
const mask = (s, start = 3, end = 7) => s.split("").fill("*", start, end).join("");

// 容量汇总变量
let totalPersonalGB = 0;
let totalFamilyGB = 0;
const capacityDetails = [];
const message = [];

// 延迟函数 (保留，家庭任务可能仍需使用)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 核心任务逻辑 (仅保留个人签到)
const doTask = async (cloudClient) => {
  const result = [];
  
  // 仅执行个人签到
  const res1 = await cloudClient.userSign();
  result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得 ${res1.netdiskBonus}M 空间`);
  
  return result; // 直接返回，无后续任务
};

// 家庭空间任务（强制指定ID）
const doFamilyTask = async (cloudClient) => {
  const result = [];
  const specifiedFamilyId = "165515815004439"; 

  try {
    const res = await cloudClient.familyUserSign(specifiedFamilyId);
    result.push(
      `家庭空间 ${specifiedFamilyId.slice(-4)}：${res.signStatus ? "已签到" : "签到成功"}，获得 ${res.bonusSpace}M 空间`
    );
  } catch (err) {
    console.error(`处理指定家庭空间 ${specifiedFamilyId} 时出错：`, err.message);
    result.push(`⚠️ 家庭空间 ${specifiedFamilyId} 签到失败：${err.message}`);
  }

  return result;
};

// 主执行函数（保持不变）
async function main(userName, password) {
  const userNameInfo = mask(userName);
  try {
    message.push(`\n🔔 账号 ${userNameInfo} 开始执行`);
    const cloudClient = new CloudClient(userName, password);
    
    if (!await cloudClient.login()) {
      message.push(`❌ 账号 ${userNameInfo} 登录失败`);
      return;
    }

    // 执行任务（仍可并行）
    const [taskResult, familyResult] = await Promise.all([
      doTask(cloudClient),
      doFamilyTask(cloudClient)
    ]);
    
    message.push(...taskResult, ...familyResult);

    // 容量统计（保持不变）
    const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
    const personalGB = (cloudCapacityInfo?.totalSize || 0) / 1024**3;
    const familyGB = (familyCapacityInfo?.totalSize || 0) / 1024**3;

    totalPersonalGB += personalGB;
    totalFamilyGB += familyGB;
    capacityDetails.push({ userNameInfo, personalGB, familyGB });

    message.push(
      `📦 当前容量：个人 ${personalGB.toFixed(2)}G | 家庭 ${familyGB.toFixed(2)}G`
    );

  } catch (e) {
    message.push(`⚠️ 账号 ${userNameInfo} 执行异常：${e.message}`);
  } finally {
    message.push(`✅ 账号 ${userNameInfo} 执行完毕`);
  }
}

// 程序入口（保持不变）
(async () => {
  try {
    const c189s = process.env.CLOUD_189?.split('\n').filter(line => line.includes('|')) || [];
    
    if (!c189s.length) {
      message.push("❌ 未配置环境变量 CLOUD_189");
      return;
    }

    for (const account of c189s) {
      const [username, password] = account.split('|');
      if (username?.trim() && password?.trim()) {
        await main(username.trim(), password.trim());
        await delay(5000); // 保留账号间隔
      }
    }

    if (capacityDetails.length) {
      message.push("\n📊 ===== 容量汇总 =====");
      capacityDetails.forEach(({ userNameInfo, personalGB, familyGB }) => {
        message.push(
          `${userNameInfo.padEnd(10)}：个人 ${personalGB.toFixed(2).padStart(8)}G | 家庭 ${familyGB.toFixed(2).padStart(8)}G`
        );
      });
      message.push(
        "🔻".padEnd(25, "─"), 
        `总计：个人 ${totalPersonalGB.toFixed(2)}G | 家庭 ${totalFamilyGB.toFixed(2)}G`
      );
    }

  } catch (e) {
    message.push(`⚠️ 全局异常：${e.message}`);
  } finally {
    console.log(message.join('\n'));
    await QLAPI?.notify?.('天翼云盘签到', message.join('\n'));
  }
})();
