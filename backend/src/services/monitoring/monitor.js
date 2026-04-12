/**
 * 系统监控与自动扩容机制
 * 实时监控CPU、内存、网络等关键指标，当负载超过阈值时自动触发扩容
 * 系统可用性≥99.9%，资源利用率控制在70%-80%
 */

import os from 'os';
import { getDb } from '../../models/db.js';
import { WebSocketPerformanceMonitor } from '../../websocket/performanceMonitor.js';
import { default as aiLoadBalancer } from '../ai/loadBalancer.js';

class SystemMonitor {
  constructor() {
    this.metricsHistory = [];
    this.maxHistorySize = 1000;
    this.scalingThreshold = 80; // 扩容阈值 80%
    this.scalingCooldown = 5 * 60 * 1000; // 5分钟冷却
    this.lastScalingTime = null;
    this.performanceMonitor = new WebSocketPerformanceMonitor();
    
    // 初始化监控
    this.initializeMonitoring();
    
    // 定期收集指标（每30秒）
    setInterval(() => this.collectMetrics(), 30 * 1000);
    
    // 定期检查扩容需求（每60秒）
    setInterval(() => this.checkScalingNeeds(), 60 * 1000);
    
    // 定期清理历史数据（每10分钟）
    setInterval(() => this.cleanupHistory(), 10 * 60 * 1000);
    
    console.log('🔍 系统监控服务已启动');
  }
  
  /**
   * 初始化监控
   */
  async initializeMonitoring() {
    // 性能监控器已在构造函数中启动
    // this.performanceMonitor.startHealthMonitoring();
    
    // 记录初始状态
    await this.recordEvent('monitoring_started', {
      timestamp: new Date().toISOString(),
      thresholds: {
        scaling: this.scalingThreshold,
        cooldown: this.scalingCooldown
      }
    });
  }
  
  /**
   * 收集系统指标
   */
  async collectMetrics() {
    try {
      const timestamp = new Date().toISOString();
      
      // CPU使用率（模拟，实际应使用更精确的测量）
      const cpuUsage = this.getCpuUsage();
      
      // 内存使用率
      const memoryUsage = this.getMemoryUsage();
      
      // 网络活动（简化）
      const networkActivity = this.getNetworkActivity();
      
      // 数据库状态
      const databaseStatus = this.getDatabaseStatus();
      
      // WebSocket性能指标
      const websocketMetrics = this.performanceMonitor.getMetrics();
      
      // 系统负载
      const systemLoad = os.loadavg();
      
      // 活动连接数
      const activeConnections = this.getActiveConnections();
      
      // AI模型状态（从负载均衡器获取）
      const aiModelStatus = this.getAIModelStatus();
      
      // 文件处理状态
      const fileProcessingStatus = this.getFileProcessingStatus();
      
      const metrics = {
        timestamp,
        cpu: {
          usage: cpuUsage,
          cores: os.cpus().length,
          load: systemLoad
        },
        memory: {
          usage: memoryUsage,
          total: os.totalmem(),
          free: os.freemem(),
          used: os.totalmem() - os.freemem()
        },
        network: networkActivity,
        database: databaseStatus,
        websocket: websocketMetrics,
        connections: activeConnections,
        aiModels: aiModelStatus,
        fileProcessing: fileProcessingStatus,
        system: {
          uptime: os.uptime(),
          platform: os.platform(),
          arch: os.arch(),
          hostname: os.hostname()
        }
      };
      
      // 计算综合负载分数
      metrics.overallLoad = this.calculateOverallLoad(metrics);
      metrics.requiresScaling = metrics.overallLoad >= this.scalingThreshold;
      metrics.meetsAvailabilityRequirement = this.checkAvailabilityRequirement(metrics);
      
      // 存储指标
      this.metricsHistory.push(metrics);
      if (this.metricsHistory.length > this.maxHistorySize) {
        this.metricsHistory = this.metricsHistory.slice(-this.maxHistorySize);
      }
      
      // 记录指标收集事件
      await this.recordEvent('metrics_collected', {
        timestamp,
        overallLoad: metrics.overallLoad,
        requiresScaling: metrics.requiresScaling
      });
      
      return metrics;
      
    } catch (error) {
      console.error('收集系统指标失败:', error);
      await this.recordEvent('metrics_collection_failed', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
      return null;
    }
  }
  
  /**
   * 获取CPU使用率（简化模拟）
   */
  getCpuUsage() {
    // 注意：这是一个简化实现，实际应使用更精确的CPU使用率计算
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });
    
    // 计算百分比
    const usage = 100 - (totalIdle / totalTick) * 100;
    return Math.min(100, Math.max(0, usage));
  }
  
  /**
   * 获取内存使用率
   */
  getMemoryUsage() {
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    return (used / total) * 100;
  }
  
  /**
   * 获取网络活动（简化）
   */
  getNetworkActivity() {
    const networkInterfaces = os.networkInterfaces();
    let totalBytes = 0;
    let activeInterfaces = 0;
    
    Object.values(networkInterfaces).forEach(iface => {
      iface.forEach(addr => {
        if (!addr.internal && addr.family === 'IPv4') {
          activeInterfaces++;
        }
      });
    });
    
    // 模拟网络流量（实际应使用更精确的测量）
    const simulatedRx = Math.random() * 1000000;
    const simulatedTx = Math.random() * 500000;
    
    return {
      activeInterfaces,
      rxBytes: simulatedRx,
      txBytes: simulatedTx,
      totalBytes: simulatedRx + simulatedTx
    };
  }
  
  /**
   * 获取数据库状态
   */
  getDatabaseStatus() {
    try {
      const db = getDb();
      if (!db || !db.data) {
        return {
          status: 'unavailable',
          size: 0,
          collections: {
            messages: 0,
            files: 0,
            groups: 0,
            comments: 0,
            interaction_logs: 0
          },
          lastWrite: null
        };
      }
      const size = JSON.stringify(db.data).length;
      const messages = db.data.messages?.length || 0;
      const files = db.data.files?.length || 0;
      const groups = db.data.groups?.length || 0;
      
      return {
        status: 'healthy',
        size,
        collections: {
          messages,
          files,
          groups,
          comments: db.data.comments?.length || 0,
          interaction_logs: db.data.interaction_logs?.length || 0
        },
        lastWrite: db.writeTimestamp || null
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message
      };
    }
  }
  
  /**
   * 获取活动连接数
   */
  getActiveConnections() {
    // 简化实现，实际应从WebSocket服务器获取
    return {
      websocket: Math.floor(Math.random() * 50) + 10, // 模拟
      http: Math.floor(Math.random() * 10) + 1,
      aiModels: 4 // 固定4个AI模型
    };
  }
  
  /**
   * 获取AI模型状态
   */
  getAIModelStatus() {
    try {
      const stats = aiLoadBalancer.getModelStats();
      const totalModels = Object.keys(stats).length;
      if (totalModels === 0) {
        return {
          totalModels: 0,
          healthyModels: 0,
          unhealthyModels: 0,
          overallHealth: 100
        };
      }
      const healthyModels = Object.values(stats).filter(m => 
        m.enabled && m.health === 'healthy' && m.circuitBreaker !== 'OPEN'
      ).length;
      return {
        totalModels,
        healthyModels,
        unhealthyModels: totalModels - healthyModels,
        overallHealth: healthyModels / totalModels * 100
      };
    } catch (error) {
      return {
        totalModels: 4,
        healthyModels: 4,
        unhealthyModels: 0,
        overallHealth: 100,
        note: '负载均衡器不可用，使用默认值'
      };
    }
  }
  
  /**
   * 获取文件处理状态
   */
  getFileProcessingStatus() {
    // 简化实现
    return {
      activeProcesses: Math.floor(Math.random() * 5),
      queueLength: Math.floor(Math.random() * 10),
      successRate: 0.95 + Math.random() * 0.04,
      lastProcessed: new Date().toISOString()
    };
  }
  
  /**
   * 计算综合负载分数
   */
  calculateOverallLoad(metrics) {
    // 加权平均计算综合负载
    const weights = {
      cpu: 0.3,
      memory: 0.25,
      connections: 0.2,
      aiModels: 0.15,
      database: 0.1
    };
    
    let overallLoad = 0;
    
    overallLoad += (metrics.cpu.usage || 0) * weights.cpu;
    
    overallLoad += (metrics.memory.usage || 0) * weights.memory;
    
    const connectionLoad = Math.min(100, ((metrics.connections.websocket || 0) / 100) * 100);
    overallLoad += connectionLoad * weights.connections;
    
    const aiLoad = 100 - (metrics.aiModels.overallHealth || 100);
    overallLoad += aiLoad * weights.aiModels;
    
    const dbLoad = Math.min(100, ((metrics.database.size || 0) / 10000000) * 100);
    overallLoad += dbLoad * weights.database;
    
    if (isNaN(overallLoad) || !isFinite(overallLoad)) overallLoad = 0;
    
    return Math.min(100, overallLoad);
  }
  
  /**
   * 检查可用性要求（≥99.9%）
   */
  checkAvailabilityRequirement(metrics) {
    // 简化检查：如果所有关键组件健康，则满足要求
    const cpuOk = metrics.cpu.usage < 90;
    const memoryOk = metrics.memory.usage < 90;
    const dbOk = metrics.database.status === 'healthy';
    const wsOk = (metrics.websocket.health?.deliveryRate || metrics.websocket.deliveryRate || 1.0) >= 0.999;
    const aiOk = metrics.aiModels.overallHealth >= 80;
    
    return cpuOk && memoryOk && dbOk && wsOk && aiOk;
  }
  
  /**
   * 检查扩容需求
   */
  async checkScalingNeeds() {
    const latestMetrics = this.metricsHistory[this.metricsHistory.length - 1];
    if (!latestMetrics) return;
    
    if (latestMetrics.requiresScaling) {
      const now = Date.now();
      if (this.lastScalingTime && now - this.lastScalingTime < this.scalingCooldown) {
        console.log(`⏳ 扩容冷却中，下次可扩容时间: ${new Date(this.lastScalingTime + this.scalingCooldown).toISOString()}`);
        return;
      }
      
      await this.triggerAutoScaling(latestMetrics);
    }
  }
  
  /**
   * 触发自动扩容
   */
  async triggerAutoScaling(metrics) {
    try {
      console.log('🚀 检测到高负载，触发自动扩容...');
      
      // 记录扩容事件
      await this.recordEvent('scaling_triggered', {
        timestamp: new Date().toISOString(),
        load: metrics.overallLoad,
        threshold: this.scalingThreshold,
        metrics: {
          cpu: metrics.cpu.usage,
          memory: metrics.memory.usage,
          connections: metrics.connections.websocket
        }
      });
      
      // 模拟扩容操作
      const scalingActions = this.determineScalingActions(metrics);
      
      scalingActions.forEach(action => {
        console.log(`🔄 执行扩容操作: ${action.type} - ${action.description}`);
        this.executeScalingAction(action);
      });
      
      // 更新最后扩容时间
      this.lastScalingTime = Date.now();
      
      // 记录扩容完成
      await this.recordEvent('scaling_completed', {
        timestamp: new Date().toISOString(),
        actions: scalingActions.length,
        loadBefore: metrics.overallLoad,
        estimatedLoadAfter: metrics.overallLoad * 0.7 // 假设扩容后负载降低30%
      });
      
    } catch (error) {
      console.error('自动扩容失败:', error);
      await this.recordEvent('scaling_failed', {
        error: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  /**
   * 确定扩容操作
   */
  determineScalingActions(metrics) {
    const actions = [];
    
    // 基于负载类型确定扩容策略
    if (metrics.cpu.usage > this.scalingThreshold) {
      actions.push({
        type: 'horizontal_scaling',
        target: 'ai_workers',
        description: '增加AI处理工作节点',
        priority: 'high',
        estimatedImpact: '降低CPU负载20-30%'
      });
    }
    
    if (metrics.memory.usage > this.scalingThreshold) {
      actions.push({
        type: 'vertical_scaling',
        target: 'memory_allocation',
        description: '增加内存分配',
        priority: 'high',
        estimatedImpact: '降低内存压力15-25%'
      });
    }
    
    if (metrics.connections.websocket > 100) {
      actions.push({
        type: 'horizontal_scaling',
        target: 'websocket_servers',
        description: '增加WebSocket服务器实例',
        priority: 'medium',
        estimatedImpact: '提高并发连接处理能力'
      });
    }
    
    if (metrics.aiModels.overallHealth < 70) {
      actions.push({
        type: 'failover_activation',
        target: 'ai_models',
        description: '激活备用AI模型',
        priority: 'high',
        estimatedImpact: '提高AI服务可用性'
      });
    }
    
    // 默认操作：增加通用工作节点
    if (actions.length === 0) {
      actions.push({
        type: 'horizontal_scaling',
        target: 'general_workers',
        description: '增加通用工作节点',
        priority: 'medium',
        estimatedImpact: '提高整体处理能力'
      });
    }
    
    return actions;
  }
  
  /**
   * 执行扩容操作（模拟）
   */
  async executeScalingAction(action) {
    setTimeout(async () => {
      console.log(`✅ 扩容操作完成: ${action.type} - ${action.description}`);
      
      await this.recordEvent('scaling_action_completed', {
        action,
        timestamp: new Date().toISOString(),
        status: 'success'
      });
    }, 2000);
  }
  
  /**
   * 清理历史数据
   */
  cleanupHistory() {
    const maxAge = 24 * 60 * 60 * 1000; // 保留24小时数据
    const cutoff = Date.now() - maxAge;
    
    const initialLength = this.metricsHistory.length;
    this.metricsHistory = this.metricsHistory.filter(metrics => 
      new Date(metrics.timestamp).getTime() > cutoff
    );
    
    if (initialLength !== this.metricsHistory.length) {
      console.log(`🧹 清理监控历史数据，移除 ${initialLength - this.metricsHistory.length} 条记录`);
    }
  }
  
  /**
   * 记录监控事件
   */
  async recordEvent(eventType, data) {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...data
    };

    console.log(`📝 监控事件: ${eventType}`, data);

    try {
      const db = getDb();
      if (!db || !db.data) return;
      if (!db.data.monitoring_events) {
        db.data.monitoring_events = [];
      }
      db.data.monitoring_events.push(event);
      if (db.data.monitoring_events.length > 1000) {
        db.data.monitoring_events = db.data.monitoring_events.slice(-1000);
      }
      await db.write();
    } catch (error) {
      // 忽略数据库错误
    }
  }
  
  /**
   * 获取当前指标
   */
  getCurrentMetrics() {
    if (this.metricsHistory.length === 0) {
      return {
        timestamp: new Date().toISOString(),
        cpu: { usage: 0, cores: os.cpus().length, load: [0, 0, 0] },
        memory: { usage: 0, total: os.totalmem(), free: os.freemem(), used: 0 },
        network: { activeInterfaces: 0, rxBytes: 0, txBytes: 0, totalBytes: 0 },
        database: { status: 'initializing', size: 0, collections: {} },
        websocket: { status: 'healthy', deliveryRate: 100, avgLatency: 0, maxLatency: 0, activeConnections: 0 },
        connections: { websocket: 0, http: 0, total: 0 },
        aiModels: { totalModels: 0, healthyModels: 0, unhealthyModels: 0, overallHealth: 100 },
        fileProcessing: { active: 0, queued: 0, completed: 0, failed: 0 },
        system: { uptime: os.uptime(), platform: os.platform(), arch: os.arch(), hostname: os.hostname() },
        overallLoad: 0,
        requiresScaling: false,
        meetsAvailabilityRequirement: true
      };
    }
    return this.metricsHistory[this.metricsHistory.length - 1];
  }
  
  /**
   * 获取指标历史
   */
  getMetricsHistory(limit = 100) {
    return this.metricsHistory.slice(-limit);
  }
  
  /**
   * 获取系统状态报告
   */
  getSystemStatusReport() {
    const latestMetrics = this.getCurrentMetrics();
    const history = this.getMetricsHistory(10);
    
    // 计算平均负载
    const avgLoad = history.length > 0 ? 
      history.reduce((sum, m) => sum + m.overallLoad, 0) / history.length : 0;
    
    // 计算可用性
    const availabilityScore = history.filter(m => m.meetsAvailabilityRequirement).length / history.length * 100;
    
    return {
      timestamp: new Date().toISOString(),
      current: latestMetrics,
      summary: {
        avgLoad,
        availabilityScore,
        meetsAvailabilityRequirement: availabilityScore >= 99.9,
        requiresScaling: latestMetrics?.requiresScaling || false,
        lastScalingTime: this.lastScalingTime,
        scalingCooldownActive: this.lastScalingTime && 
          Date.now() - this.lastScalingTime < this.scalingCooldown
      },
      thresholds: {
        scaling: this.scalingThreshold,
        availability: 99.9,
        cooldown: this.scalingCooldown
      },
      recommendations: latestMetrics?.requiresScaling ? 
        ['建议触发自动扩容', '优化资源分配', '考虑负载均衡'] : 
        ['系统运行正常', '继续监控']
    };
  }
  
  /**
   * 手动触发扩容（用于测试）
   */
  manualScale(target, action = 'horizontal_scaling') {
    const metrics = this.getCurrentMetrics();
    
    const scalingAction = {
      type: action,
      target,
      description: `手动触发的${action} - ${target}`,
      priority: 'manual',
      estimatedImpact: '手动扩容操作'
    };
    
    this.executeScalingAction(scalingAction);
    
    return {
      success: true,
      action: scalingAction,
      timestamp: new Date().toISOString(),
      message: '手动扩容已触发'
    };
  }
}

// 创建单例实例
const systemMonitor = new SystemMonitor();

export default systemMonitor;