import crypto from 'crypto';
import { getKey, getKeyMetadata, getKeyByVersion, generateNewKey, loadOrGenerateEncryptionKey } from './keyManager.js';

const ENCRYPTION_CONFIG = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16
};

function getEncryptionKeyBuffer() {
  return getKey();
}

export function encryptData(data, options = {}) {
  try {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');

    // GCM 下 IV 绝不允许由调用方指定（IV 复用会灾难性破坏加密安全性），始终随机生成。
    const iv = crypto.randomBytes(ENCRYPTION_CONFIG.ivLength);
    
    const keyBuffer = getEncryptionKeyBuffer();
    const metadata = getKeyMetadata();
    
    const cipher = crypto.createCipheriv(
      ENCRYPTION_CONFIG.algorithm,
      keyBuffer,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );
    
    if (options.additionalData) {
      cipher.setAAD(Buffer.from(options.additionalData));
    }
    
    const encrypted = Buffer.concat([
      cipher.update(dataBuffer),
      cipher.final()
    ]);
    
    const authTag = cipher.getAuthTag();
    
    const result = {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: ENCRYPTION_CONFIG.algorithm,
      keyVersion: metadata.version,
      timestamp: new Date().toISOString()
    };
    
    return result;
    
  } catch (error) {
    console.error('加密数据失败:', error);
    throw new Error(`加密失败: ${error.message}`);
  }
}

export function decryptData(encryptedData) {
  try {
    const {
      encrypted: encryptedBase64,
      iv: ivBase64,
      authTag: authTagBase64,
      additionalData,
      keyVersion
    } = encryptedData;
    
    if (!encryptedBase64 || !ivBase64 || !authTagBase64) {
      throw new Error('缺少必需的加密数据字段');
    }
    
    const encrypted = Buffer.from(encryptedBase64, 'base64');
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');
    
    let keyBuffer;
    if (keyVersion) {
      const versionedKey = getKeyByVersion(keyVersion);
      if (versionedKey) {
        keyBuffer = versionedKey;
      } else {
        keyBuffer = getEncryptionKeyBuffer();
        console.warn(`密钥版本 ${keyVersion} 未找到，使用当前密钥尝试解密`);
      }
    } else {
      keyBuffer = getEncryptionKeyBuffer();
    }
    
    const decipher = crypto.createDecipheriv(
      ENCRYPTION_CONFIG.algorithm,
      keyBuffer,
      iv,
      { authTagLength: ENCRYPTION_CONFIG.authTagLength }
    );
    
    decipher.setAuthTag(authTag);
    
    if (additionalData) {
      decipher.setAAD(Buffer.from(additionalData));
    }
    
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);
    
    return decrypted.toString('utf8');
    
  } catch (error) {
    throw new Error(`解密失败: ${error.message}`);
  }
}

export function encryptObject(obj, options = {}) {
  try {
    const jsonString = JSON.stringify(obj);
    return encryptData(jsonString, options);
  } catch (error) {
    console.error('加密对象失败:', error);
    throw new Error(`对象加密失败: ${error.message}`);
  }
}

export function decryptObject(encryptedData) {
  try {
    const jsonString = decryptData(encryptedData);
    return JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`对象解密失败: ${error.message}`);
  }
}

export function encryptText(text) {
  try {
    const encrypted = encryptData(text);
    return JSON.stringify(encrypted);
  } catch (error) {
    console.error('加密文本失败:', error);
    throw new Error(`文本加密失败: ${error.message}`);
  }
}

export function decryptText(encryptedJson) {
  if (!encryptedJson || typeof encryptedJson !== 'string') {
    return encryptedJson;
  }
  let parsed;
  try {
    parsed = JSON.parse(encryptedJson);
  } catch {
    // 非 JSON 输入：按历史明文数据处理（兼容未加密的存量数据）
    return encryptedJson;
  }
  if (!parsed || !parsed.encrypted || !parsed.iv || !parsed.authTag || !parsed.algorithm) {
    return encryptedJson;
  }
  try {
    const result = decryptData(parsed);
    if (typeof result !== 'string') {
      throw new Error('解密结果不是字符串');
    }
    return result;
  } catch (err) {
    // 密文存在但解密失败：密钥不匹配或数据被篡改，绝不把密文当明文返回
    console.error('解密文本失败（密钥不匹配或数据被篡改）:', err.message);
    return '[无法解密]';
  }
}

export function generateRandomKey(length = ENCRYPTION_CONFIG.keyLength) {
  try {
    const randomBytes = crypto.randomBytes(length);
    return randomBytes.toString('base64');
  } catch (error) {
    console.error('生成随机密钥失败:', error);
    throw new Error(`密钥生成失败: ${error.message}`);
  }
}

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

export function verifyEncryptionIntegrity(encryptedData) {
  try {
    decryptData(encryptedData);
    return true;
  } catch (error) {
    return false;
  }
}

export function getEncryptionConfig() {
  const metadata = getKeyMetadata();
  
  return {
    ...ENCRYPTION_CONFIG,
    keyConfigured: !!process.env.ENCRYPTION_KEY,
    keySource: process.env.ENCRYPTION_KEY ? 'environment' : 'file',
    keyLengthBytes: getEncryptionKeyBuffer().length,
    keyVersion: metadata.version,
    algorithmSupported: true,
    timestamp: new Date().toISOString()
  };
}

export { getKey, generateNewKey, loadOrGenerateEncryptionKey, getKeyMetadata } from './keyManager.js';

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
  getEncryptionConfig,
  getKey,
  generateNewKey,
  loadOrGenerateEncryptionKey,
  getKeyMetadata
};
