/**
 * 进程内资源采样与扩容建议。
 * 当前没有真实扩容适配器或可用性 SLO 时间序列；相关状态保持未知。
 */

import os from 'os';
import { WebSocketPerformanceMonitor } from '../../websocket/performanceMonitor.js';

class SystemMonitor {
  constructor() {
    this.metricsHistory = [];
    this.maxHistorySize = 1000;
    this.scalingThreshold = 80;
    this.scalingCooldown = 5 * 60 * 1000;
    this.lastScalingTime = null;
    this.lastRecommendationTime = null;
    this.performanceMonitor = new WebSocketPerformanceMonitor();
    this._timers = [];
    this._wss = null;
    this._requestCounter = { total: 0, lastReset: Date.now() };
    this._lastCpuSample = null;
    this.eventLog = [];
    this.maxEventLogSize = 500;
    
    if (process.env.NODE_ENV !== 'test') {
      this.initializeMonitoring();
      this._timers.push(setInterval(() => this.collectMetrics(), 30 * 1000));
      this._timers.push(setInterval(() => this.checkScalingNeeds(), 60 * 1000));
      this._timers.push(setInterval(() => this.cleanupHistory(), 10 * 60 * 1000));
      for (const timer of this._timers) {
        if (typeof timer.unref === 'function') timer.unref();
      }
      console.log('🔍 系统监控服务已启动');
    }
  }
  
  cleanupTimers() {
    for (const timer of this._timers) {
      clearInterval(timer);
    }
    this._timers = [];
    console.log('🔍 系统监控定时器已清理');
  }
  
  setWss(wss) {
    this._wss = wss;
  }
  
  incrementRequestCount() {
    this._requestCounter.total++;
  }
  
  async initializeMonitoring() {
    await this.recordEvent('monitoring_started', {
      timestamp: new Date().toISOString(),
      thresholds: {
        scaling: this.scalingThreshold,
        cooldown: this.scalingCooldown
      }
    });
  }
  
  async collectMetrics() {
    try {
      const timestamp = new Date().toISOString();
      const cpuUsage = this.getCpuUsage();
      const effectiveCpuUsage = cpuUsage === null
        ? (this.metricsHistory.length > 0 ? this.metricsHistory[this.metricsHistory.length - 1].cpu?.usage ?? null : null)
        : cpuUsage;
      const memoryUsage = this.getMemoryUsage();
      const networkActivity = this.getNetworkActivity();
      const databaseStatus = await this.getDatabaseStatus();
      const websocketMetrics = this.performanceMonitor.getMetrics();
      const systemLoad = os.loadavg();
      const activeConnections = this.getActiveConnections();
      const aiModelStatus = this.getAIModelStatus();
      const fileProcessingStatus = this.getFileProcessingStatus();
      
      const metrics = {
        timestamp,
        cpu: {
          usage: effectiveCpuUsage,
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
      metrics.requiresScaling = metrics.overallLoad !== null && metrics.overallLoad >= this.scalingThreshold;
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
    // CPU 使用率必须基于两次采样的 tick 差值；os.cpus().times 是开机以来的累计值，
    // 直接计算会得到近似恒定的错误结果。
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;

    cpus.forEach(cpu => {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    });

    const last = this._lastCpuSample;
    this._lastCpuSample = { totalIdle, totalTick };

    if (!last || totalTick <= last.totalTick) {
      return null; // 首次采样或时钟未推进，暂无有效使用率
    }

    const idleDelta = totalIdle - last.totalIdle;
    const tickDelta = totalTick - last.totalTick;
    const usage = 100 - (idleDelta / tickDelta) * 100;
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
    // Restricted containers may deny interface enumeration. Keep independently
    // measurable request/database metrics available; missing evidence is unknown.
    let activeInterfaces = null;
    try {
      activeInterfaces = Object.values(os.networkInterfaces()).reduce((count, addresses) =>
        count + (addresses || []).filter(address => !address.internal && address.family === 'IPv4').length, 0);
    } catch { /* No interface permissions does not make the app unavailable. */ }

    const elapsed = (Date.now() - this._requestCounter.lastReset) / 1000;
    const requestsPerSecond = elapsed > 0 ? this._requestCounter.total / elapsed : 0;
    
    return {
      activeInterfaces,
      totalRequests: this._requestCounter.total,
      requestsPerSecond: Math.round(requestsPerSecond * 100) / 100,
      rxBytes: null,
      txBytes: null,
      totalBytes: null
    };
  }
  
  /**
   * 获取数据库状态（轻量级：仅报告存储后端与用户数量，不做全库序列化）
   */
  async getDatabaseStatus() {
    try {
      const { listUserDatabases } = await import('../../models/db.js');
      const { isCloudDbEnabled } = await import('../../models/supabaseAdapter.js');
      const userIds = await listUserDatabases();
      return {
        status: Array.isArray(userIds) ? 'listing_available' : 'unavailable',
        evidence: 'list_user_databases',
        backend: process.env.SUPABASE_DB_URL ? 'supabase' : (process.env.MONGODB_URI ? 'mongodb' : 'lowdb'),
        cloudEnabled: !!isCloudDbEnabled(),
        userCount: Array.isArray(userIds) ? userIds.length : 0,
        lastWrite: null
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
    const wsConnections = this._wss ? this._wss.clients.size : 0;
    return {
      websocket: wsConnections,
      http: null,
      aiModels: null // No authoritative per-user model count is available in this process-wide view.
    };
  }
  
  /**
   * 获取AI模型状态
   */
  getAIModelStatus() {
    return {
      totalModels: null,
      healthyModels: null,
      unhealthyModels: null,
      overallHealth: null,
      status: 'unknown',
      note: '缺少按用户模型目录关联的真实调用、费用和健康账本'
    };
  }
  
  /**
   * 获取文件处理状态
   */
  getFileProcessingStatus() {
    return {
      status: 'not_available',
      message: '文件处理状态数据不可用'
    };
  }
  
  /**
   * 计算综合负载分数
   */
  calculateOverallLoad(metrics) {
    const samples = [
      { value: metrics.cpu?.usage, weight: 0.3 },
      { value: metrics.memory?.usage, weight: 0.25 }
    ].filter(sample => typeof sample.value === 'number' && Number.isFinite(sample.value));
    if (!samples.length) return null;
    // WebSocket count lacks an installed capacity limit; database size is not
    // collected. Neither is a trustworthy saturation percentage.
    const weight = samples.reduce((sum, sample) => sum + sample.weight, 0);
    return Math.min(100, samples.reduce((sum, sample) => sum + sample.value * sample.weight, 0) / weight);
  }
  
  /**
   * 检查可用性要求（≥99.9%）
   */
  checkAvailabilityRequirement(metrics) {
    // A process snapshot cannot establish a 99.9% availability SLO.
    return null;
  }
  
  /**
   * 检查扩容需求
   */
  async checkScalingNeeds() {
    const latestMetrics = this.metricsHistory[this.metricsHistory.length - 1];
    if (!latestMetrics) return;
    
    if (latestMetrics.requiresScaling) {
      const now = Date.now();
      if (this.lastRecommendationTime && now - this.lastRecommendationTime < this.scalingCooldown) {
        console.log(`⏳ 扩容建议冷却中，下次评估时间: ${new Date(this.lastRecommendationTime + this.scalingCooldown).toISOString()}`);
        return;
      }
      
      await this.triggerAutoScaling(latestMetrics);
    }
  }
  
  /**
   * 触发自动扩容
   */
  async triggerAutoScaling(metrics) {
    const actions = this.determineScalingActions(metrics);
    await this.recordEvent('scaling_recommended', {
      load: metrics.overallLoad,
      threshold: this.scalingThreshold,
      actions
    });
    this.lastRecommendationTime = Date.now();
    return { executed: false, reason: 'no_scaling_adapter_configured', actions };
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
    if (actions.length === 0 && metrics.overallLoad >= this.scalingThreshold) {
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
    // 诚实标注：当前为单进程部署，无真实水平扩容能力。
    // 此处仅记录建议动作，不伪造“扩容完成”事件。
    const timer = setTimeout(() => {
      console.log(`ℹ️ 扩容建议（单进程部署未执行）: ${action.type} - ${action.description}`);
    }, 0);
    if (typeof timer.unref === 'function') timer.unref();
    return { executed: false, reason: 'single-process deployment', action };
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
   * 记录监控事件（进程内环形缓冲，绝不写入任何用户数据库）
   */
  async recordEvent(eventType, data) {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...data
    };

    console.log(`📝 监控事件: ${eventType}`, data);

    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEventLogSize) {
      this.eventLog.splice(0, this.eventLog.length - this.maxEventLogSize);
    }
  }

  getRecentEvents(limit = 100) {
    return this.eventLog.slice(-limit);
  }
  
  /**
   * 获取当前指标
   */
  getCurrentMetrics() {
    if (this.metricsHistory.length === 0) {
      return {
        timestamp: new Date().toISOString(),
        cpu: { usage: null, cores: os.cpus().length, load: null },
        memory: { usage: null, total: os.totalmem(), free: os.freemem(), used: null },
        network: { activeInterfaces: null, rxBytes: null, txBytes: null, totalBytes: null },
        database: { status: 'initializing', size: 0, collections: {} },
        websocket: { status: 'unknown', deliveryRate: null, avgLatency: null, maxLatency: null, activeConnections: 0 },
        connections: { websocket: 0, http: null, total: null },
        aiModels: this.getAIModelStatus(),
        fileProcessing: { active: 0, queued: 0, completed: 0, failed: 0 },
        system: { uptime: os.uptime(), platform: os.platform(), arch: os.arch(), hostname: os.hostname() },
        overallLoad: null,
        requiresScaling: null,
        meetsAvailabilityRequirement: null
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
    const measuredLoads = history.map(m => m.overallLoad).filter(value => typeof value === 'number' && Number.isFinite(value));
    const avgLoad = measuredLoads.length ?
      measuredLoads.reduce((sum, value) => sum + value, 0) / measuredLoads.length : null;
    
    // 计算可用性
    const availabilityScore = null; // No uptime/error-budget time series is recorded yet.
    
    return {
      timestamp: new Date().toISOString(),
      current: latestMetrics,
      summary: {
        avgLoad,
        availabilityScore,
        meetsAvailabilityRequirement: null,
        requiresScaling: latestMetrics?.requiresScaling ?? null,
        lastScalingTime: this.lastScalingTime,
        lastRecommendationTime: this.lastRecommendationTime,
        scalingCooldownActive: this.lastRecommendationTime &&
          Date.now() - this.lastRecommendationTime < this.scalingCooldown
      },
      thresholds: {
        scaling: this.scalingThreshold,
        availability: 99.9,
        cooldown: this.scalingCooldown
      },
      recommendations: latestMetrics?.requiresScaling ?
        ['资源负载偏高；需要人工检查扩容方案'] :
        ['服务等级可用性尚未建立有效观测；继续收集真实请求与错误数据']
    };
  }
  
  /**
   * 手动触发扩容（用于测试）
   */
  manualScale(target, action = 'horizontal_scaling') {
    return {
      success: false,
      executed: false,
      action: { type: action, target },
      timestamp: new Date().toISOString(),
      message: '未配置扩容适配器，未执行扩容'
    };
  }
}

// 创建单例实例
const systemMonitor = new SystemMonitor();

export default systemMonitor;
