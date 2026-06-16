import crypto from 'crypto';

export function generateCSRFToken() {
    return crypto.randomBytes(32).toString('hex');
}

export function csrfProtection(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        return next();
    }

    const cookieToken = req.cookies?.['csrf_token'];
    const headerToken = req.headers['x-csrf-token'];

    if (!cookieToken || !headerToken) {
        return res.status(403).json({ error: 'CSRF令牌缺失' });
    }

    try {
        if (!crypto.timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))) {
            return res.status(403).json({ error: 'CSRF令牌无效' });
        }
    } catch {
        return res.status(403).json({ error: 'CSRF令牌验证失败' });
    }

    next();
}