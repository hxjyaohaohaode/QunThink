/**
 * AES-256-GCM 端到端加密工具
 * 提供数据加密、解密、密钥管理功能
 * 符合数据安全标准，支持加密存储和传输
 */

import crypto from 'crypto';

// 加密配置
const ENCRYPTION_CONFIG = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16
};

// 从环境变量获取加密密钥
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

// 如果没有设置环境变量，使用内存中的密钥（仅用于开发）
if (!ENCRYPTION_KEY) {
  console.warn('⚠️  安全警告：未设置 ENCRYPTION_KEY 环境变量，使用开发密钥。生产环境必须设置 ENCRYPTION_KEY，否则数据加密不安全！');
  ENCRYPTION_KEY = 'dev_encryption_key_do_not_use_in_production_123456';
}

if (process.env.NODE_ENV === 'production' && !process.env.ENCRYPTION_KEY) {
  console.error('❌ 生产环境未设置 ENCRYPTION_KEY，数据加密将不安全！');
}

// 确保密钥长度符合要求
function ensureKeyLength(key) {
  if (key.length >= 32) {
    return Buffer.from(key).slice(0, 32);
  }
  
  const hash = crypto.createHash('sha256');
  hash.update(key);
  const derivedKey = Buffer.from(hash.digest('hex'), 'hex');
  return derivedKey.slice(0, 32);
}

const ENCRYPTION_KEY_BUFFER = ensureKeyLength(ENCRYPTION_KEY);

/**
 * 加密数据
 * @param {string|Buffer} data - 要加密的数据
 * @param {Object} options - 加密选项
 * @returns {Object} 加密结果 { encrypted, iv, authTag, salt? }
 */
export function encryptData(data, options = {}) {
  try {
    // 准备数据
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    
    // 生成随机IV
    const iv = options.iv || crypto.randomBytes(ENCRYPTION_CONFIG.ivLength);
    
    // 创建加密器
    const cipher = crypto.createCipheriv(
      ENCRYPTION_CONFIG.algorithm,
      ENCRYPTION_KEY_BUFFER,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );
    
    // 可选附加数据（用于认证但不加密）
    if (options.additionalData) {
      cipher.setAAD(Buffer.from(options.additionalData));
    }
    
    // 执行加密
    const encrypted = Buffer.concat([
      cipher.update(dataBuffer),
      cipher.final()
    ]);
    
    // 获取认证标签
    const authTag = cipher.getAuthTag();
    
    // 返回加密结果
    const result = {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: ENCRYPTION_CONFIG.algorithm,
      timestamp: new Date().toISOString()
    };
    
    if (options.additionalData) {
      result.additionalData = options.additionalData;
    }
    
    return result;
    
  } catch (error) {
    console.error('加密数据失败:', error);
    throw new Error(`加密失败: ${error.message}`);
  }
}

/**
 * 解密数据
 * @param {Object} encryptedData - 加密数据对象 { encrypted, iv, authTag, salt?, additionalData? }
 * @returns {string} 解密后的原始字符串
 */
export function decryptData(encryptedData) {
  try {
    const {
      encrypted: encryptedBase64,
      iv: ivBase64,
      authTag: authTagBase64,
      additionalData
    } = encryptedData;
    
    if (!encryptedBase64 || !ivBase64 || !authTagBase64) {
      throw new Error('缺少必需的加密数据字段');
    }
    
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_CONFIG.algorithm,
      ENCRYPTION_KEY_BUFFER,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );
    
    // 设置认证标签
    decipher.setAuthTag(authTag);
    
    // 设置附加数据（如果存在）
    if (additionalData) {
      decipher.setAAD(Buffer.from(additionalData));
    }
    
    // 执行解密
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    // 返回原始字符串
    return decrypted.toString('utf8');
    
  } catch (error) {
    console.error('解密数据失败:', error);
    throw new Error(`解密失败: ${error.message}`);
  }
}

/**
 * 加密对象（自动序列化为JSON）
 * @param {Object} obj - 要加密的对象
 * @param {Object} options - 加密选项
 * @returns {Object} 加密结果
 */
export function encryptObject(obj, options = {}) {
  try {
    const jsonString = JSON.stringify(obj);
    return encryptData(jsonString, options);
  } catch (error) {
    console.error('加密对象失败:', error);
    throw new Error(`对象加密失败: ${error.message}`);
  }
}

/**
 * 解密对象（自动从JSON解析）
 * @param {Object} encryptedData - 加密数据对象
 * @returns {Object} 解密后的原始对象
 */
export function decryptObject(encryptedData) {
  try {
    const jsonString = decryptData(encryptedData);
    return JSON.parse(jsonString);
  } catch (error) {
    console.error('解密对象失败:', error);
    throw new Error(`对象解密失败: ${error.message}`);
  }
}

/**
 * 加密文本字段（简化接口）
 * @param {string} text - 要加密的文本
 * @returns {string} Base64编码的加密结果（包含所有元数据）
 */
export function encryptText(text) {
  try {
    const encrypted = encryptData(text);
    // 将整个加密对象序列化为JSON字符串
    return JSON.stringify(encrypted);
  } catch (error) {
    console.error('加密文本失败:', error);
    throw new Error(`文本加密失败: ${error.message}`);
  }
}

/**
 * 解密文本字段（简化接口）
 * @param {string} encryptedJson - Base64编码的加密结果JSON字符串
 * @returns {string} 解密后的原始文本，如果解密失败则返回原始内容
 */
export function decryptText(encryptedJson) {
  if (!encryptedJson || typeof encryptedJson !== 'string') {
    return encryptedJson;
  }
  
  // 检查是否是加密的JSON格式
  if (!encryptedJson.startsWith('{') || !encryptedJson.includes('"encrypted"')) {
    // 不是加密格式，直接返回原始内容
    return encryptedJson;
  }
  
  try {
    const encryptedData = JSON.parse(encryptedJson);
    
    // 验证是否是有效的加密数据格式
    if (!encryptedData.encrypted || !encryptedData.iv || !encryptedData.authTag) {
      return encryptedJson; // 格式不完整，返回原始内容
    }
    
    return decryptData(encryptedData);
  } catch (error) {
    // 解密失败，返回原始内容（可能是明文）
    return encryptedJson;
  }
}

/**
 * 生成安全随机密钥
 * @param {number} length - 密钥长度（字节）
 * @returns {string} Base64编码的随机密钥
 */
export function generateRandomKey(length = ENCRYPTION_CONFIG.keyLength) {
  try {
    const randomBytes = crypto.randomBytes(length);
    return randomBytes.toString('base64');
  } catch (error) {
    console.error('生成随机密钥失败:', error);
    throw new Error(`密钥生成失败: ${error.message}`);
  }
}

/**
 * 计算数据哈希（用于完整性验证）
 * @param {string|Buffer} data - 要哈希的数据
 * @param {string} algorithm - 哈希算法（默认sha256）
 * @returns {string} 十六进制哈希值
 */
export function computeHash(data, algorithm = 'sha256') {
  try {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    const hash = crypto.createHash(algorithm);
    hash.update(dataBuffer);
    return hash.digest('hex');
  } catch (error) {
    console.error('计算哈希失败:', error);
    throw new Error(`哈希计算失败: ${error.message}`);
  }
}

/**
 * 验证加密数据的完整性
 * @param {Object} encryptedData - 加密数据对象
 * @returns {boolean} 是否完整
 */
export function verifyEncryptionIntegrity(encryptedData) {
  try {
    // 尝试解密（如果解密成功则完整性通过）
    decryptData(encryptedData);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * 加密数据库字段（自动处理字段映射）
 * @param {Object} data - 原始数据对象
 * @param {Array} fieldsToEncrypt - 需要加密的字段名数组
 * @returns {Object} 加密后的数据对象
 */
export function encryptDatabaseFields(data, fieldsToEncrypt = ['content', 'message', 'password', 'token', 'secret']) {
  try {
    const encryptedData = { ...data };
    
    for (const field of fieldsToEncrypt) {
      if (encryptedData[field] && typeof encryptedData[field] === 'string') {
        // 加密字段
        encryptedData[field] = encryptText(encryptedData[field]);
        // 添加标记
        encryptedData[`${field}_encrypted`] = true;
        encryptedData[`${field}_encryption_version`] = 'aes-256-gcm-v1';
      }
    }
    
    return encryptedData;
  } catch (error) {
    console.error('加密数据库字段失败:', error);
    throw new Error(`数据库字段加密失败: ${error.message}`);
  }
}

/**
 * 解密数据库字段（自动处理字段映射）
 * @param {Object} data - 加密数据对象
 * @param {Array} fieldsToDecrypt - 需要解密的字段名数组
 * @returns {Object} 解密后的数据对象
 */
export function decryptDatabaseFields(data, fieldsToDecrypt = ['content', 'message', 'password', 'token', 'secret']) {
  try {
    const decryptedData = { ...data };
    
    for (const field of fieldsToDecrypt) {
      const encryptedField = decryptedData[field];
      const isEncrypted = decryptedData[`${field}_encrypted`];
      
      if (isEncrypted && encryptedField && typeof encryptedField === 'string') {
        try {
          // 解密字段
          decryptedData[field] = decryptText(encryptedField);
          // 移除标记
          delete decryptedData[`${field}_encrypted`];
          delete decryptedData[`${field}_encryption_version`];
        } catch (decryptError) {
          console.warn(`字段 ${field} 解密失败，保留原始数据:`, decryptError.message);
          // 解密失败，保留原始加密数据
        }
      }
    }
    
    return decryptedData;
  } catch (error) {
    console.error('解密数据库字段失败:', error);
    throw new Error(`数据库字段解密失败: ${error.message}`);
  }
}

/**
 * 获取当前加密配置
 * @returns {Object} 加密配置信息
 */
export function getEncryptionConfig() {
  return {
    ...ENCRYPTION_CONFIG,
    keyConfigured: !!process.env.ENCRYPTION_KEY,
    keySource: process.env.ENCRYPTION_KEY ? 'environment' : 'development',
    keyLengthBytes: ENCRYPTION_KEY_BUFFER.length,
    algorithmSupported: true,
    timestamp: new Date().toISOString()
  };
}

// 导出默认实例
export default {
  encryptData,
  decryptData,
  encryptObject,
  decryptObject,
  encryptText,
  decryptText,
  generateRandomKey,
  computeHash,
  verifyEncryptionIntegrity,
  encryptDatabaseFields,
  decryptDatabaseFields,
  getEncryptionConfig
};