import DypnsApiModule from '@alicloud/dypnsapi20170525';
import { Config } from '@alicloud/openapi-client';
import { RuntimeOptions } from '@alicloud/tea-util';
import { safeLog } from '../../utils/logger.js';

const DypnsClient = DypnsApiModule.default?.default || DypnsApiModule.default || DypnsApiModule;
const SendSmsVerifyCodeRequest = DypnsApiModule.SendSmsVerifyCodeRequest || DypnsApiModule.default?.SendSmsVerifyCodeRequest;
const CheckSmsVerifyCodeRequest = DypnsApiModule.CheckSmsVerifyCodeRequest || DypnsApiModule.default?.CheckSmsVerifyCodeRequest;

const PHONE_REGEX = /^1[3-9]\d{9}$/;

const SMS_SEND_LOCKS = new Map();
const SMS_LOCK_TTL = 60 * 1000;

let dypnsClient = null;

function createDypnsClient() {
  const accessKeyId = process.env.ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.ALIYUN_ACCESS_KEY_SECRET;

  if (!accessKeyId || !accessKeySecret) {
    safeLog('warn', '阿里云短信配置缺失，短信功能不可用');
    return null;
  }

  const config = new Config({
    accessKeyId,
    accessKeySecret,
    endpoint: 'dypnsapi.aliyuncs.com',
  });

  return new DypnsClient(config);
}

export function initSmsClient() {
  dypnsClient = createDypnsClient();
  if (dypnsClient) {
    console.log('✅ 阿里云短信客户端初始化成功');
  } else {
    console.warn('⚠️  阿里云短信客户端未初始化，短信功能不可用');
  }
  return dypnsClient;
}

export function isSmsConfigured() {
  return !!dypnsClient;
}

export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: '请输入手机号' };
  }
  if (!PHONE_REGEX.test(phone)) {
    return { valid: false, error: '手机号格式不正确' };
  }
  return { valid: true };
}

function checkSendLock(phone) {
  const now = Date.now();
  const lockTime = SMS_SEND_LOCKS.get(phone);
  if (lockTime && now - lockTime < SMS_LOCK_TTL) {
    const remaining = Math.ceil((SMS_LOCK_TTL - (now - lockTime)) / 1000);
    return { locked: true, remaining };
  }
  return { locked: false };
}

function setSendLock(phone) {
  SMS_SEND_LOCKS.set(phone, Date.now());
}

export async function sendSmsVerifyCode(phone) {
  if (!dypnsClient) {
    throw new Error('短信服务未配置');
  }

  const phoneValidation = validatePhone(phone);
  if (!phoneValidation.valid) {
    throw new Error(phoneValidation.error);
  }

  const lock = checkSendLock(phone);
  if (lock.locked) {
    throw new Error(`操作过于频繁，请${lock.remaining}秒后再试`);
  }

  const signName = process.env.ALIYUN_SMS_SIGN_NAME;
  const templateCode = process.env.ALIYUN_SMS_TEMPLATE_CODE;

  if (!signName || !templateCode) {
    throw new Error('短信签名或模板未配置');
  }

  const request = new SendSmsVerifyCodeRequest({
    phoneNumber: phone,
    signName,
    templateCode,
    templateParam: '{"code":"##code##","min":"5"}',
    codeType: 1,
    codeLength: 6,
    validTime: 300,
    interval: 60,
  });

  const runtime = new RuntimeOptions({});

  try {
    const response = await dypnsClient.sendSmsVerifyCodeWithOptions(request, runtime);
    const body = response.body;

    if (body.code === 'OK') {
      setSendLock(phone);
      safeLog('info', `验证码发送成功: ${phone.substring(0, 3)}****${phone.substring(7)}`);
      return { success: true, message: '验证码已发送' };
    }

    const errorMsg = body.message || '发送失败';
    safeLog('warn', `验证码发送失败: ${body.code} - ${errorMsg}`);

    if (body.code === 'BUSINESS_LIMIT_CONTROL') {
      throw new Error('发送过于频繁，请稍后再试');
    }
    if (body.code === 'INVALID_PARAMETERS') {
      throw new Error('参数错误，请检查手机号是否正确');
    }
    if (body.code === 'SIGNATURE_ILLEGAL') {
      throw new Error('短信签名不合法');
    }
    if (body.code === 'TEMPLATE_MISSING_PARAMETERS') {
      throw new Error('短信模板参数不完整');
    }

    throw new Error(errorMsg);
  } catch (err) {
    if (err.message && (
      err.message.includes('操作过于频繁') ||
      err.message.includes('发送失败') ||
      err.message.includes('参数错误') ||
      err.message.includes('短信签名') ||
      err.message.includes('模板参数') ||
      err.message.includes('发送过于频繁')
    )) {
      throw err;
    }
    safeLog('error', '短信发送异常:', { error: err.message });
    throw new Error('验证码发送失败，请稍后再试');
  }
}

export async function checkSmsVerifyCode(phone, code) {
  if (!dypnsClient) {
    throw new Error('短信服务未配置');
  }

  const phoneValidation = validatePhone(phone);
  if (!phoneValidation.valid) {
    throw new Error(phoneValidation.error);
  }

  if (!code || typeof code !== 'string' || !/^\d{4,8}$/.test(code)) {
    throw new Error('验证码格式不正确');
  }

  const request = new CheckSmsVerifyCodeRequest({
    phoneNumber: phone,
    verifyCode: code,
  });

  const runtime = new RuntimeOptions({});

  try {
    const response = await dypnsClient.checkSmsVerifyCodeWithOptions(request, runtime);
    const body = response.body;

    if (body.code === 'OK') {
      const verifyResult = body.model?.verifyResult;
      if (verifyResult === 'PASS') {
        safeLog('info', `验证码校验通过: ${phone.substring(0, 3)}****${phone.substring(7)}`);
        return { success: true, verified: true };
      }
      safeLog('warn', `验证码校验失败: ${phone.substring(0, 3)}****${phone.substring(7)}, result=${verifyResult}`);
      return { success: true, verified: false, message: '验证码错误或已过期' };
    }

    const errorMsg = body.message || '校验失败';
    safeLog('warn', `验证码校验接口失败: ${body.code} - ${errorMsg}`);
    throw new Error(errorMsg);
  } catch (err) {
    if (err.message && (
      err.message.includes('验证码错误') ||
      err.message.includes('校验失败')
    )) {
      throw err;
    }
    safeLog('error', '验证码校验异常:', { error: err.message });
    throw new Error('验证码校验失败，请稍后再试');
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [phone, lockTime] of SMS_SEND_LOCKS) {
    if (now - lockTime > SMS_LOCK_TTL) {
      SMS_SEND_LOCKS.delete(phone);
    }
  }
}, 60 * 1000);
