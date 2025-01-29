const { CloudClient } = require("cloud189-sdk");

// 敏感信息掩码工具
const mask = (s, start = 3, end = 7) => s.split("").fill("*", start, end).join("");

// 容量统计相关
const capacityDetails = [];
const message = [];

// 构建抽奖结果
const buildTaskResult = (res, result) => {
  const index = result.length + 1;
  result.push(
    res.errorCode === "User_Not_Chance" 
      ? `第${index}次抽奖失败，次数不足` 
      : `第${index}次抽奖成功，获得 ${res.prizeName}`
  );
};

// 延迟函数
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// 核心任务逻辑
const doTask = async cloudClient => {
  const result = [];
  
  // 个人签到
  const res1 = await cloudClient.userSign();
  result.push(`${res1.isSign ? "已签到" : "签到成功"}，获得 ${res1.netdiskBonus}M 空间`);
  
  // 抽奖任务
  const lotteryTasks = [
    cloudClient.taskSign(),
    cloudClient.taskPhoto(),
    cloudClient.taskKJ()
  ];

  for (let i = 0; i < lotteryTasks.length; i++) {
    await delay(5000);
    buildTaskResult(await lotteryTasks[i], result);
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
        const res = await cloudClient.familyUserSign(String(165515815004439));
        result.push(
          `家庭空间${String(familyId).slice(-4)}：${res.signStatus ? "已签到" : "签到成功"}，获得 ${res.bonusSpace}M 空间`
        );
      }
    } else {
      result.push("未找到家庭空间信息");
    }
  } catch (e) {
    result.push(`家庭空间任务异常：${e.message}`);
  }
  return result;
};

// 主执行函数
async function main(userName, password) {
  const userNameInfo = mask(userName);
  try {
    message.push(`\n账号 ${userNameInfo} 开始执行`);
    const cloudClient = new CloudClient(userName, password);

    if (!await cloudClient.login()) {
      message.push(`账号 ${userNameInfo} 登录失败`);
      return;
    }

    // 并行执行任务
    const [taskResult, familyResult] = await Promise.all([
      doTask(cloudClient),
      doFamilyTask(cloudClient)
    ]);

    // 记录任务结果
    message.push(...taskResult, ...familyResult);

    // 收集容量数据
    const { cloudCapacityInfo, familyCapacityInfo } = await cloudClient.getUserSizeInfo();
    
    // 计算新增容量
    const personalAddedMB = taskResult
      .filter(item => item.includes("获得") && item.includes("M"))
      .reduce((sum, item) => sum + parseInt((item.match(/(\d+)M/) || [0,0])[1]), 0);

    const familyAddedMB = familyResult
      .filter(item => item.includes("获得") && item.includes("M"))
      .reduce((sum, item) => sum + parseInt((item.match(/(\d+)M/) || [0,0])[1]), 0);

    // 存储容量信息
    capacityDetails.push({
      userNameInfo,
      originalPersonalGB: (cloudCapacityInfo?.usedSize || 0) / 1024**3,
      originalFamilyGB: (familyCapacityInfo?.usedSize || 0) / 1024**3,
      personalAddedMB,
      familyAddedMB
    });

    message.push(`当前容量：个人 ${(cloudCapacityInfo.totalSize / 1024**3).toFixed(2)}G | 家庭 ${(familyCapacityInfo.totalSize / 1024**3).toFixed(2)}G`);

  } catch (e) {
    message.push(`账号 ${userNameInfo} 执行异常：${e.message}`);
  } finally {
    message.push(`账号 ${userNameInfo} 执行完毕`);
  }
}

// 程序入口
(async () => {
  try {
    const c189s = process.env.CLOUD_189?.split('\n') || [];
    
    if (!c189s.length) {
      message.push("未配置环境变量 CLOUD_189");
      return;
    }

    // 遍历执行所有账号
    for (const account of c189s) {
      const [username, password] = account.split('|');
      if (username?.trim() && password?.trim()) {
        await main(username.trim(), password.trim());
        await delay(3000);
      }
    }

    // 生成容量汇总表
    if (capacityDetails.length) {
      const firstAccount = capacityDetails[0];
      const totalFamilyAddedMB = capacityDetails.reduce((sum, cur) => sum + cur.familyAddedMB, 0);

      message.push(
        '\n┌───────────────┬───────────────┬───────────────┐',
        '│   容量类型    │    个人云     │    家庭云     │',
        '├───────────────┼───────────────┼───────────────┤',
        `│ 原始容量 (GB) │ ${String(firstAccount.originalPersonalGB.toFixed(2)).padStart(13)} │ ${String(firstAccount.originalFamilyGB.toFixed(2)).padStart(13)} │`,
        '├───────────────┼───────────────┼───────────────┤',
        `│ 新增容量 (MB) │ ${String(firstAccount.personalAddedMB).padStart(13)} │ ${String(totalFamilyAddedMB).padStart(13)} │`,
        '├───────────────┼───────────────┼───────────────┤',
        `│ 当前总计 (GB) │ ${String((firstAccount.originalPersonalGB + firstAccount.personalAddedMB/1024).toFixed(2)).padStart(13)} │ ${String((firstAccount.originalFamilyGB + totalFamilyAddedMB/1024).toFixed(2)).padStart(13)} │`,
        '└───────────────┴───────────────┴───────────────┘'
      );
    }

  } catch (e) {
    message.push(`全局异常：${e.message}`);
  } finally {
    console.log(message.join('\n'));
    await QLAPI?.notify?.('天翼云盘签到', message.join('\n'));
  }
})();
