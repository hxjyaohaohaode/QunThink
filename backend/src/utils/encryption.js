import crypto from 'crypto';
import { getKey, getKeyMetadata, getKeyByVersion, generateNewKey, loadOrGenerateEncryptionKey } from './keyManager.js';

const ENCRYPTION_CONFIG = {
  algorithm: 'aes-256-gcm',
  keyLength: 32,
  ivLength: 16,
  authTagLength: 16
};

function ensureKeyLength(key) {
  if (key.length >= 32) {
    return Buffer.from(key).slice(0, 32);
  }
  
  const hash = crypto.createHash('sha256');
  hash.update(key);
  const derivedKey = Buffer.from(hash.digest('hex'), 'hex');
  return derivedKey.slice(0, 32);
}

function getEncryptionKeyBuffer() {
  return getKey();
}

export function encryptData(data, options = {}) {
  try {
    const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    
    const iv = options.iv || crypto.randomBytes(ENCRYPTION_CONFIG.ivLength);
    
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
    
    if (options.additionalData) {
      result.additionalData = options.additionalData;
    }
    
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
  try {
    const parsed = JSON.parse(encryptedJson);
    if (!parsed.encrypted || !parsed.iv || !parsed.authTag || !parsed.algorithm) {
      return encryptedJson;
    }
    return decryptData(parsed);
  } catch {
    return encryptedJson;
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

export function encryptDatabaseFields(data, fieldsToEncrypt = ['content', 'message', 'password', 'token', 'secret']) {
  try {
    const encryptedData = { ...data };
    
    for (const field of fieldsToEncrypt) {
      if (encryptedData[field] && typeof encryptedData[field] === 'string') {
        encryptedData[field] = encryptText(encryptedData[field]);
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

export function decryptDatabaseFields(data, fieldsToDecrypt = ['content', 'message', 'password', 'token', 'secret']) {
  try {
    const decryptedData = { ...data };
    
    for (const field of fieldsToDecrypt) {
      const encryptedField = decryptedData[field];
      const isEncrypted = decryptedData[`${field}_encrypted`];
      
      if (isEncrypted && encryptedField && typeof encryptedField === 'string') {
        try {
          decryptedData[field] = decryptText(encryptedField);
          delete decryptedData[`${field}_encrypted`];
          delete decryptedData[`${field}_encryption_version`];
        } catch (decryptError) {
          console.warn(`字段 ${field} 解密失败，保留原始数据:`, decryptError.message);
        }
      }
    }
    
    return decryptedData;
  } catch (error) {
    console.error('解密数据库字段失败:', error);
    throw new Error(`数据库字段解密失败: ${error.message}`);
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
  encryptDatabaseFields,
  decryptDatabaseFields,
  getEncryptionConfig,
  getKey,
  generateNewKey,
  loadOrGenerateEncryptionKey,
  getKeyMetadata
};
