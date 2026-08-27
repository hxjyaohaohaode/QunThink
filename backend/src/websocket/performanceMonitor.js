/**
 * WebSocket性能监控模块
 * 确保消息延迟不超过500ms，消息送达率达到99.9%
 */

class WebSocketPerformanceMonitor {
  constructor() {
    this.metrics = {
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      failedDeliveries: 0,
      deliveryConfirmations: 0,
      messageLatencies: [],
      connectionStats: {
        totalConnections: 0,
        activeConnections: 0,
        reconnections: 0,
        connectionErrors: 0
      },
      health: {
        deliveryRate: null,
        avgLatency: 0,
        maxLatency: 0,
        status: 'healthy'
      }
    };

    this.config = {
      maxLatencyThreshold: 500, // ms
      minDeliveryRate: 0.999,   // 99.9%
      sampleSize: 1000,
      healthCheckInterval: 30000 // 30秒
    };

    this.messageTracking = new Map(); // messageId -> { sentAt, confirmedAt, targetClientId }
    this._healthCheckTimer = null;

    this.startHealthMonitoring();
  }

  cleanup() {
    if (this._healthCheckTimer) {
      clearInterval(this._healthCheckTimer);
      this._healthCheckTimer = null;
    }
    console.log('[WebSocket性能监控] 定时器已清理');
  }

  /**
   * 开始消息跟踪
   */
  trackMessage(messageId, clientId) {
    const trackInfo = {
      messageId,
      clientId,
      sentAt: Date.now(),
      confirmedAt: null,
      deliveryConfirmed: false
    };

    this.messageTracking.set(messageId, trackInfo);

    // 设置超时检查
    setTimeout(() => {
      this.checkDeliveryTimeout(messageId);
    }, this.config.maxLatencyThreshold * 2);

    return trackInfo;
  }

  /**
   * 确认消息送达（客户端ACK路径）
   */
  confirmDelivery(messageId, confirmationTime = Date.now()) {
    const trackInfo = this.messageTracking.get(messageId);
    if (!trackInfo) return false;

    trackInfo.confirmedAt = confirmationTime;
    trackInfo.deliveryConfirmed = true;

    // 计算延迟
    const latency = confirmationTime - trackInfo.sentAt;
    this.recordLatency(latency);

    // 更新送达确认计数
    this.metrics.deliveryConfirmations++;

    this.messageTracking.delete(messageId);
    this.updateHealthMetrics();

    return true;
  }

  /**
   * 标记消息已送达（发送成功路径）
   */
  markDelivered(messageId) {
    return this.confirmDelivery(messageId, Date.now());
  }

  /**
   * 标记消息送达失败并从跟踪表删除
   */
  markFailed(messageId) {
    const ids = Array.isArray(messageId) ? messageId : [messageId];
    let marked = 0;
    ids.forEach(id => {
      const trackInfo = this.messageTracking.get(id);
      if (!trackInfo) return;
      this.messageTracking.delete(id);
      marked++;
    });
    if (marked > 0) {
      this.metrics.failedDeliveries += marked;
      this.updateHealthMetrics();
    }
    return marked;
  }

  /**
   * 连接关闭时批量标记该连接所有未确认消息为失败（防泄漏）
   */
  failPendingForClient(clientId) {
    const pendingIds = [];
    this.messageTracking.forEach((trackInfo, messageId) => {
      if (trackInfo.clientId === clientId && !trackInfo.deliveryConfirmed) {
        pendingIds.push(messageId);
      }
    });
    return this.markFailed(pendingIds);
  }

  /**
   * 记录延迟
   */
  recordLatency(latency) {
    this.metrics.messageLatencies.push(latency);

    // 保持样本大小
    if (this.metrics.messageLatencies.length > this.config.sampleSize) {
      this.metrics.messageLatencies = this.metrics.messageLatencies.slice(-this.config.sampleSize);
    }

    // 更新统计
    this.updateHealthMetrics();
  }

  /**
   * 检查送达超时（超时未确认即计为失败，条目删除防止泄漏）
   */
  checkDeliveryTimeout(messageId) {
    const trackInfo = this.messageTracking.get(messageId);
    if (!trackInfo) return;

    if (!trackInfo.deliveryConfirmed) {
      this.metrics.failedDeliveries++;
      this.messageTracking.delete(messageId);
      this.updateHealthMetrics();
    }
  }

  /**
   * 记录发送消息
   */
  recordMessageSent() {
    this.metrics.totalMessagesSent++;
  }

  /**
   * 记录接收消息
   */
  recordMessageReceived() {
    this.metrics.totalMessagesReceived++;
  }

  /**
   * 记录连接事件
   */
  recordConnectionEvent(eventType) {
    switch (eventType) {
      case 'connected':
        this.metrics.connectionStats.totalConnections++;
        this.metrics.connectionStats.activeConnections++;
        break;
      case 'disconnected':
        this.metrics.connectionStats.activeConnections =
          Math.max(0, this.metrics.connectionStats.activeConnections - 1);
        break;
      case 'reconnected':
        this.metrics.connectionStats.reconnections++;
        break;
      case 'error':
        this.metrics.connectionStats.connectionErrors++;
        break;
    }
  }

  /**
   * 更新健康指标
   */
  updateHealthMetrics() {
    // 计算送达率：无任何已判定结果的数据时返回 null（未知），不伪造 1.0
    const totalDeliveries = this.metrics.deliveryConfirmations + this.metrics.failedDeliveries;
    this.metrics.health.deliveryRate = totalDeliveries > 0 ?
      this.metrics.deliveryConfirmations / totalDeliveries : null;

    // 计算平均延迟
    if (this.metrics.messageLatencies.length > 0) {
      const sum = this.metrics.messageLatencies.reduce((a, b) => a + b, 0);
      this.metrics.health.avgLatency = sum / this.metrics.messageLatencies.length;
      this.metrics.health.maxLatency = this.metrics.messageLatencies.reduce((a, b) => Math.max(a, b), 0);
    }

    // 确定状态（deliveryRate 未知时不参与降级判定）
    const rate = this.metrics.health.deliveryRate;
    const rateDegraded = rate !== null && (
      rate < this.config.minDeliveryRate || rate < 0.99
    );

    if ((rateDegraded && rate < 0.99) ||
        this.metrics.health.avgLatency > 1000) {
      this.metrics.health.status = 'poor';
    } else if (rateDegraded ||
               this.metrics.health.avgLatency > this.config.maxLatencyThreshold) {
      this.metrics.health.status = 'degraded';
    } else {
      this.metrics.health.status = 'healthy';
    }
  }

  /**
   * 开始健康监控
   */
  startHealthMonitoring() {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    this._healthCheckTimer = setInterval(() => {
      this.updateHealthMetrics();
      this.logHealthStatus();
    }, this.config.healthCheckInterval);

    if (typeof this._healthCheckTimer.unref === 'function') {
      this._healthCheckTimer.unref();
    }
  }

  /**
   * 记录健康状态
   */
  logHealthStatus() {
    const health = this.metrics.health;
    const connections = this.metrics.connectionStats;
    const rateText = health.deliveryRate === null
      ? 'N/A(无数据)'
      : `${(health.deliveryRate * 100).toFixed(2)}%`;

    console.log(`[WebSocket性能监控] 状态: ${health.status}, 送达率: ${rateText}, 平均延迟: ${health.avgLatency.toFixed(2)}ms, 最大延迟: ${health.maxLatency}ms, 活跃连接: ${connections.activeConnections}`);

    if (health.status !== 'healthy') {
      console.warn(`[WebSocket性能监控警告] 性能下降: 送达率=${rateText}, 平均延迟=${health.avgLatency.toFixed(2)}ms`);
    }
  }

  /**
   * 获取性能指标
   */
  getMetrics() {
    this.updateHealthMetrics();

    return {
      ...this.metrics,
      currentTime: new Date().toISOString(),
      config: this.config,
      activeMessageTracking: this.messageTracking.size,
      recentLatencies: this.metrics.messageLatencies.slice(-10)
    };
  }

  /**
   * 重置指标
   */
  resetMetrics() {
    this.metrics = {
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      failedDeliveries: 0,
      deliveryConfirmations: 0,
      messageLatencies: [],
      connectionStats: {
        totalConnections: 0,
        activeConnections: 0,
        reconnections: 0,
        connectionErrors: 0
      },
      health: {
        deliveryRate: null,
        avgLatency: 0,
        maxLatency: 0,
        status: 'healthy'
      }
    };

    this.messageTracking.clear();

    console.log('[WebSocket性能监控] 指标已重置');
  }

  /**
   * 检查是否满足性能要求
   */
  checkPerformanceRequirements() {
    this.updateHealthMetrics();

    const meetsDeliveryRate = this.metrics.health.deliveryRate === null ||
      this.metrics.health.deliveryRate >= this.config.minDeliveryRate;
    const meetsLatency = this.metrics.health.avgLatency <= this.config.maxLatencyThreshold;

    return {
      meetsRequirements: meetsDeliveryRate && meetsLatency,
      deliveryRate: {
        current: this.metrics.health.deliveryRate,
        required: this.config.minDeliveryRate,
        meets: meetsDeliveryRate
      },
      latency: {
        current: this.metrics.health.avgLatency,
        required: this.config.maxLatencyThreshold,
        meets: meetsLatency
      },
      status: this.metrics.health.status
    };
  }
}

// 创建单例实例
const wsPerformanceMonitor = new WebSocketPerformanceMonitor();

export default wsPerformanceMonitor;

// 导出功能
export {
  wsPerformanceMonitor,
  WebSocketPerformanceMonitor
};
