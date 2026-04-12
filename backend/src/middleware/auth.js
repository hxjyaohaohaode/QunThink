const authMiddleware = (req, res, next) => {
  let userId = req.headers['x-user-id'];

  if (!userId) {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 10);
    userId = `user-${timestamp}-${random}`;
  }

  req.userId = userId;
  next();
};

export default authMiddleware;
