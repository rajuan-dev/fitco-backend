import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import config from './config';
import { notFound, errorHandler } from './middlewares/errorMiddleware';

import authRoutes from './modules/auth/routes';
import userRoutes from './modules/user/routes';
import adminRoutes from './modules/admin/routes';
import subscriptionRoutes from './modules/subscription/routes';
import couponRoutes from './modules/coupon/routes';
import chatRoutes from './modules/chat/routes';
import reportRoutes from './modules/report/routes';
import cmsRoutes from './modules/cms/routes';
import dashboardRoutes from './modules/dashboard/routes';
import foodDatabaseRoutes from './modules/foodDatabase/routes';
import foodLogRoutes from './modules/foodLog/routes';
import customFoodRoutes from './modules/customFood/routes';
import uploadRoutes from './modules/upload/routes';
import { stripeWebhook } from './modules/subscription/controller';

const app = express();
const API_PREFIX = '/api/v1';

app.use(helmet());
app.use(cors({ origin: true, credentials: true }));
app.post(`${API_PREFIX}/subscriptions/webhook`, express.raw({ type: 'application/json' }), stripeWebhook);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());
app.use((req, res, next) => {
  const incomingRequestId = req.headers['x-request-id'];
  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim()
      ? incomingRequestId.trim()
      : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});
app.use(morgan(config.env === 'development' ? 'dev' : 'combined'));

app.get(`${API_PREFIX}/health`, (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get(`${API_PREFIX}/subscriptions/success`, (_req, res) => {
  res.type('html').send(
    '<h2>Subscription payment successful</h2><p>Your payment was received. You can close this page.</p>'
  );
});

app.get(`${API_PREFIX}/subscriptions/cancel`, (_req, res) => {
  res.type('html').send(
    '<h2>Subscription checkout canceled</h2><p>No payment was charged. You can return to the app.</p>'
  );
});

app.use(`${API_PREFIX}/auth`, authRoutes);
app.use(`${API_PREFIX}/users`, userRoutes);
app.use(`${API_PREFIX}/admin`, adminRoutes);
app.use(`${API_PREFIX}/subscription`, subscriptionRoutes);
app.use(`${API_PREFIX}/subscriptions`, subscriptionRoutes);
app.use(`${API_PREFIX}/coupons`, couponRoutes);
app.use(`${API_PREFIX}/chat`, chatRoutes);
app.use(`${API_PREFIX}/reports`, reportRoutes);
app.use(`${API_PREFIX}/cms`, cmsRoutes);
app.use(`${API_PREFIX}/dashboard`, dashboardRoutes);
app.use(`${API_PREFIX}/food-database`, foodDatabaseRoutes);
app.use(`${API_PREFIX}/food-logs`, foodLogRoutes);
app.use(`${API_PREFIX}/custom-foods`, customFoodRoutes);
app.use(`${API_PREFIX}/uploads`, uploadRoutes);

app.use(notFound);
app.use(errorHandler);

export default app;
