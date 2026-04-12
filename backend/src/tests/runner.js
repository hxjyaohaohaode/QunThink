/**
 * 测试运行器
 * 执行性能测试与指标验证
 */

import PerformanceTestSuite from './performanceTests.js';

async function runTests() {
  console.log('🚀 启动多AI群聊系统性能测试与指标验证');
  console.log('='.repeat(60));
  console.log('');
  
  try {
    // 创建测试套件实例
    const testSuite = new PerformanceTestSuite();
    
    // 运行所有测试
    await testSuite.runAllTests();
    
    // 返回测试结果
    const { summary } = testSuite.results;
    
    console.log('');
    console.log('='.repeat(60));
    console.log('🏁 测试完成');
    console.log('='.repeat(60));
    
    if (summary.overallPassed) {
      console.log('✅ 恭喜！系统通过性能测试与指标验证');
      console.log(`   总体通过率: ${summary.overallPassRate.toFixed(1)}%`);
      console.log(`   通过测试: ${summary.passedTests}/${summary.totalTests}`);
    } else {
      console.log('❌ 系统未通过性能测试');
      console.log(`   总体通过率: ${summary.overallPassRate.toFixed(1)}% (要求≥80%)`);
      console.log(`   通过测试: ${summary.passedTests}/${summary.totalTests}`);
    }
    
    console.log('');
    
    // 详细结果分析
    console.log('📊 详细测试结果:');
    console.log('-'.repeat(40));
    
    Object.entries(testSuite.results.requirements).forEach(([category, tests]) => {
      const passedCount = Object.values(tests).filter(Boolean).length;
      const totalCount = Object.keys(tests).length;
      const passRate = (passedCount / totalCount) * 100;
      
      console.log(`${category}:`);
      console.log(`  通过率: ${passRate.toFixed(1)}% (${passedCount}/${totalCount})`);
      
      // 显示失败的测试
      const failedTests = Object.entries(tests)
        .filter(([_, passed]) => !passed)
        .map(([name]) => name);
      
      if (failedTests.length > 0) {
        console.log(`  失败项目: ${failedTests.join(', ')}`);
      }
      console.log('');
    });
    
    // 建议改进项
    console.log('💡 改进建议:');
    console.log('-'.repeat(40));
    
    const suggestions = [];
    
    // 基于测试结果生成建议
    const { requirements } = testSuite.results;
    
    if (requirements.socialInteraction) {
      const socialPassRate = Object.values(requirements.socialInteraction).filter(Boolean).length / 
        Object.keys(requirements.socialInteraction).length * 100;
      if (socialPassRate < 100) {
        suggestions.push('优化社交互动算法，提高智能点赞和评论相关性');
      }
    }
    
    if (requirements.groupChat) {
      const groupPassRate = Object.values(requirements.groupChat).filter(Boolean).length / 
        Object.keys(requirements.groupChat).length * 100;
      if (groupPassRate < 100) {
        suggestions.push('优化WebSocket连接和消息处理性能');
      }
    }
    
    if (requirements.fileSharing) {
      const filePassRate = Object.values(requirements.fileSharing).filter(Boolean).length / 
        Object.keys(requirements.fileSharing).length * 100;
      if (filePassRate < 100) {
        suggestions.push('优化文件处理和记忆检索性能');
      }
    }
    
    if (requirements.performanceSecurity) {
      const perfPassRate = Object.values(requirements.performanceSecurity).filter(Boolean).length / 
        Object.keys(requirements.performanceSecurity).length * 100;
      if (perfPassRate < 100) {
        suggestions.push('加强系统监控和自动扩容机制');
      }
    }
    
    if (requirements.aiIntegration) {
      const aiPassRate = Object.values(requirements.aiIntegration).filter(Boolean).length / 
        Object.keys(requirements.aiIntegration).length * 100;
      if (aiPassRate < 100) {
        suggestions.push('优化AI模型负载均衡和故障转移');
      }
    }
    
    if (suggestions.length === 0) {
      suggestions.push('系统表现优秀，继续保持监控和维护');
    }
    
    suggestions.forEach((suggestion, index) => {
      console.log(`${index + 1}. ${suggestion}`);
    });
    
    console.log('');
    console.log('='.repeat(60));
    
    // 根据结果退出
    process.exit(summary.overallPassed ? 0 : 1);
    
  } catch (error) {
    console.error('❌ 测试运行器执行失败:', error);
    process.exit(1);
  }
}

// 执行测试
runTests();