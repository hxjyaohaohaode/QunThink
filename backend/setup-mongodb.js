import readline from 'readline';
import crypto from 'crypto';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function generatePassword() {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let password = '';
  for (let i = 0; i < 16; i++) {
    password += chars[crypto.randomInt(chars.length)];
  }
  return password;
}

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║     🍃 MongoDB Atlas 自动配置工具 - QunThink 数据库设置     ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('本工具将帮您完成以下操作：');
  console.log('  1. 在 MongoDB Atlas 上创建数据库用户');
  console.log('  2. 设置网络访问权限（允许 Render 连接）');
  console.log('  3. 获取连接字符串');
  console.log('  4. 生成 Render 环境变量配置');
  console.log('');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📌 第一步：获取 API 密钥');
  console.log('');
  console.log('请按照以下步骤在 MongoDB Atlas 网站上操作：');
  console.log('');
  console.log('  1. 打开 https://cloud.mongodb.com 并登录');
  console.log('  2. 点击左下角你的头像/用户名');
  console.log('  3. 找到 "Access Manager" 或 "Organization Access" 或 "Account" 相关选项');
  console.log('  4. 找到 "API Keys" 或 "Create API Key" 按钮');
  console.log('  5. 创建一个新的 API Key，权限选择 "Organization Owner" 或 "Project Owner"');
  console.log('  6. 记下 Public Key 和 Private Key');
  console.log('');
  console.log('💡 如果找不到，试试这个链接：');
  console.log('   https://cloud.mongodb.com/v2#/access/organization/apiKeys');
  console.log('');

  const publicKey = await question('请输入 Public Key: ');
  const privateKey = await question('请输入 Private Key: ');

  if (!publicKey.trim() || !privateKey.trim()) {
    console.log('❌ API Key 不能为空');
    rl.close();
    return;
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📌 第二步：查找项目 ID 和集群信息');
  console.log('');

  const digestAuth = (pubKey, privKey) => {
    return Buffer.from(`${pubKey}:${privKey}`).toString('base64');
  };

  const headers = {
    'Accept': 'application/vnd.atlas.2023-02-01+json',
    'Content-Type': 'application/json',
    'Authorization': `Basic ${digestAuth(publicKey.trim(), privateKey.trim())}`
  };

  let orgId = '';
  let projectId = '';
  let clusterName = '';

  try {
    console.log('🔍 正在查找组织信息...');
    const orgsRes = await fetch('https://cloud.mongodb.com/api/atlas/v2/orgs', { headers });
    if (!orgsRes.ok) {
      const errText = await orgsRes.text();
      throw new Error(`获取组织信息失败 (${orgsRes.status}): ${errText}`);
    }
    const orgsData = await orgsRes.json();
    const orgs = orgsData.results || [];

    if (orgs.length === 0) {
      console.log('❌ 未找到组织，请确认 API Key 权限');
      rl.close();
      return;
    }

    orgId = orgs[0].id;
    console.log(`✅ 找到组织: ${orgs[0].name || orgId}`);
  } catch (err) {
    console.log(`❌ 错误: ${err.message}`);
    console.log('');
    console.log('💡 请确认：');
    console.log('   - API Key 是否正确');
    console.log('   - API Key 权限是否为 Organization Owner 或 Project Owner');
    rl.close();
    return;
  }

  try {
    console.log('🔍 正在查找项目信息...');
    const projectsRes = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups`, { headers });
    if (!projectsRes.ok) {
      throw new Error(`获取项目失败 (${projectsRes.status})`);
    }
    const projectsData = await projectsRes.json();
    const projects = projectsData.results || [];

    if (projects.length === 0) {
      console.log('❌ 未找到项目，请确认是否已创建集群');
      rl.close();
      return;
    }

    if (projects.length === 1) {
      projectId = projects[0].id;
      console.log(`✅ 找到项目: ${projects[0].name} (${projectId})`);
    } else {
      console.log('');
      console.log('找到多个项目：');
      projects.forEach((p, i) => {
        console.log(`  ${i + 1}. ${p.name} (${p.id})`);
      });
      const choice = await question('请选择项目编号: ');
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx >= projects.length) {
        console.log('❌ 无效选择');
        rl.close();
        return;
      }
      projectId = projects[idx].id;
      console.log(`✅ 已选择项目: ${projects[idx].name}`);
    }
  } catch (err) {
    console.log(`❌ 错误: ${err.message}`);
    rl.close();
    return;
  }

  try {
    console.log('🔍 正在查找集群信息...');
    const clustersRes = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/clusters`, { headers });
    if (!clustersRes.ok) {
      throw new Error(`获取集群失败 (${clustersRes.status})`);
    }
    const clustersData = await clustersRes.json();
    const clusters = clustersData.results || [];

    if (clusters.length === 0) {
      console.log('❌ 未找到集群，请先在 MongoDB Atlas 上创建一个免费集群 (M0)');
      rl.close();
      return;
    }

    clusterName = clusters[0].name;
    console.log(`✅ 找到集群: ${clusterName}`);
  } catch (err) {
    console.log(`❌ 错误: ${err.message}`);
    rl.close();
    return;
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📌 第三步：创建数据库用户');
  console.log('');

  const dbUsername = 'qunthink_user';
  const dbPassword = generatePassword();
  console.log(`🔑 自动生成数据库用户：`);
  console.log(`   用户名: ${dbUsername}`);
  console.log(`   密码: ${dbPassword}`);
  console.log('');

  try {
    console.log('⏳ 正在创建数据库用户...');
    const createUserRes = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/databaseUsers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        databaseName: 'admin',
        roles: [{ databaseName: 'admin', roleName: 'readWriteAnyDatabase' }],
        username: dbUsername,
        password: dbPassword
      })
    });

    if (!createUserRes.ok) {
      const errText = await createUserRes.text();
      if (errText.includes('already exists')) {
        console.log('⚠️ 用户已存在，跳过创建');
      } else {
        throw new Error(`创建用户失败 (${createUserRes.status}): ${errText}`);
      }
    } else {
      console.log('✅ 数据库用户创建成功！');
    }
  } catch (err) {
    console.log(`❌ 错误: ${err.message}`);
    console.log('💡 您也可以在 MongoDB Atlas 网站上手动创建用户');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📌 第四步：设置网络访问（允许所有 IP 连接）');
  console.log('');

  try {
    console.log('⏳ 正在添加 IP 访问规则 (0.0.0.0/0)...');
    const addIpRes = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/accessList`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{
        cidrBlock: '0.0.0.0/0',
        comment: 'Allow Render and all connections'
      }])
    });

    if (!addIpRes.ok) {
      const errText = await addIpRes.text();
      if (errText.includes('already exists')) {
        console.log('⚠️ IP 规则已存在，跳过');
      } else {
        throw new Error(`添加 IP 规则失败 (${addIpRes.status}): ${errText}`);
      }
    } else {
      console.log('✅ 网络访问规则添加成功！');
    }
  } catch (err) {
    console.log(`❌ 错误: ${err.message}`);
    console.log('💡 您也可以在 MongoDB Atlas 网站上手动添加');
  }

  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('📌 第五步：获取连接字符串');
  console.log('');

  let connectionStr = '';
  try {
    console.log('⏳ 正在获取连接字符串...');
    const connRes = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/clusters/${clusterName}/connectionStrings`, { headers });
    if (!connRes.ok) {
      throw new Error(`获取连接字符串失败 (${connRes.status})`);
    }
    const connData = await connRes.json();

    connectionStr = connData.standardSrvConnectionString || connData.connectionStrings?.standardSrv || '';

    if (!connectionStr) {
      const clustersInfo = await fetch(`https://cloud.mongodb.com/api/atlas/v2/groups/${projectId}/clusters/${clusterName}`, { headers });
      const clusterData = await clustersInfo.json();
      const srvHost = clusterData.srvConnectionString || clusterData.connectionStrings?.standardSrv || '';
      connectionStr = srvHost;
    }
  } catch (err) {
    console.log(`⚠️ 自动获取失败: ${err.message}`);
    console.log('💡 请在 MongoDB Atlas 网站上手动获取连接字符串');
  }

  if (connectionStr) {
    if (connectionStr.includes('mongodb+srv://')) {
      connectionStr = connectionStr.replace('mongodb+srv://', `mongodb+srv://${dbUsername}:${dbPassword}@`);
    } else {
      connectionStr = `mongodb+srv://${dbUsername}:${dbPassword}@${connectionStr}`;
    }
  } else {
    console.log('');
    console.log('⚠️ 无法自动获取连接字符串，请手动操作：');
    console.log('  1. 在 MongoDB Atlas 网站上点击集群的 "Connect" 按钮');
    console.log('  2. 选择 "Connect your application"');
    console.log('  3. 复制连接字符串');
    console.log(`  4. 将 <password> 替换为: ${dbPassword}`);
    console.log(`  5. 将 <username> 替换为: ${dbUsername}`);
    console.log('');
    connectionStr = await question('请粘贴完整的连接字符串: ');
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║                  🎉 配置完成！                               ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋 请在 Render 的 Environment Variables 中添加以下变量：');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log(`  Key:   MONGODB_URI`);
  console.log(`  Value: ${connectionStr}`);
  console.log('');
  console.log(`  Key:   MONGODB_DB_NAME`);
  console.log(`  Value: qunthink`);
  console.log('');
  console.log(`  Key:   SESSION_MAX_AGE`);
  console.log(`  Value: 2592000000`);
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('💡 操作步骤：');
  console.log('  1. 打开 https://dashboard.render.com');
  console.log('  2. 点击您的后端服务');
  console.log('  3. 点击左侧 "Environment"');
  console.log('  4. 添加上面三个环境变量');
  console.log('  5. 点击 "Save Changes"');
  console.log('  6. 等待自动重新部署');
  console.log('');
  console.log('🔑 数据库用户信息（请保存）：');
  console.log(`  用户名: ${dbUsername}`);
  console.log(`  密码: ${dbPassword}`);
  console.log('');

  rl.close();
}

main().catch(err => {
  console.error('❌ 发生错误:', err.message);
  rl.close();
});
