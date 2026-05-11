import rateLimit from 'express-rate-limit';

export const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  handler: (req, res) => {
    res.status(429).json({
      message: 'Too many chat requests, please slow down.',
      code: 'CHAT_RATE_LIMITED',
      requestId: req.requestId
    });
  }
});
