import { Request, Response } from 'express';
import { body } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import * as subscriptionService from './service';
import validate from '../../middlewares/validationMiddleware';
import { getSingleQueryParam } from '../../utils/query';
import { PLAN_TYPES } from '../../utils/constants';
import config from '../../config';

const quoteValidators = [
  body('planType').isIn(['monthly', 'yearly']),
  body('couponCode').optional().isString()
];

const checkoutValidators = [...quoteValidators];
const appleVerifyValidators = [
  body('transactionId')
    .optional({ values: 'falsy' })
    .isString()
    .trim()
    .notEmpty(),
  body('receipt')
    .optional({ values: 'falsy' })
    .isString()
    .trim()
    .notEmpty(),
  body().custom(value => {
    if (!value?.transactionId && !value?.receipt) {
      throw new Error('Either transactionId or receipt is required');
    }
    return true;
  })
];
const googleVerifyValidators = [body('purchaseToken').isString().notEmpty()];

export const listPlans = asyncHandler(async (_req: Request, res: Response) => {
  const plans = await subscriptionService.getPlans();
  res.json({ plans });
});

export const getSubscriptionQuote = [
  ...quoteValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const quote = await subscriptionService.getSubscriptionQuote({
      planType: req.body.planType,
      couponCode: req.body.couponCode
    });
    res.json(quote);
  })
];

export const createCheckoutSession = [
  ...checkoutValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const checkout = await subscriptionService.createCheckoutSession({
      userId: req.auth!.id,
      planType: req.body.planType,
      couponCode: req.body.couponCode
    });
    res.status(201).json(checkout);
  })
];

export const stripeWebhook = asyncHandler(async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'];
  if (!signature || Array.isArray(signature)) {
    return res.status(400).json({ message: 'Missing stripe-signature header' });
  }
  await subscriptionService.processStripeWebhook(req.body as Buffer, signature);
  res.json({ received: true });
});

export const verifyApplePurchase = [
  ...appleVerifyValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await subscriptionService.verifyAppleSubscription({
      userId: req.auth!.id,
      transactionId: req.body.transactionId,
      receipt: req.body.receipt
    });
    res.json({ success: true, ...result });
  })
];

export const verifyGooglePurchase = [
  ...googleVerifyValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await subscriptionService.verifyGoogleSubscription({
      userId: req.auth!.id,
      purchaseToken: req.body.purchaseToken
    });
    res.json(result);
  })
];

export const syncRevenueCatPurchase = asyncHandler(async (req: Request, res: Response) => {
  const result = await subscriptionService.syncRevenueCatSubscription(req.auth!.id);
  res.json(result);
});

export const getSubscriptionStatus = asyncHandler(async (req: Request, res: Response) => {
  const data = await subscriptionService.getUserSubscriptionStatus(req.auth!.id);
  res.json(data);
});

export const appleWebhook = asyncHandler(async (req: Request, res: Response) => {
  const result = await subscriptionService.processAppleWebhook(req.body as Record<string, unknown>);
  res.json(result);
});

export const googleWebhook = asyncHandler(async (req: Request, res: Response) => {
  const result = await subscriptionService.processGoogleWebhook(req.body as Record<string, unknown>);
  res.json(result);
});

export const revenueCatWebhook = asyncHandler(async (req: Request, res: Response) => {
  if (config.revenueCat.webhookAuthToken) {
    const authorization = req.headers.authorization;
    const expectedAuthorization = `Bearer ${config.revenueCat.webhookAuthToken}`;
    const tokenHeader =
      typeof req.headers['x-revenuecat-webhook-token'] === 'string' ? req.headers['x-revenuecat-webhook-token'] : '';

    if (authorization !== expectedAuthorization && tokenHeader !== config.revenueCat.webhookAuthToken) {
      return res.status(401).json({ message: 'Unauthorized RevenueCat webhook' });
    }
  }

  const result = await subscriptionService.processRevenueCatWebhook(req.body as Record<string, unknown>);
  res.json(result);
});

export const listSubscriptions = asyncHandler(async (req: Request, res: Response) => {
  const page = getSingleQueryParam(req.query.page) ?? '1';
  const limit = getSingleQueryParam(req.query.limit) ?? '20';
  const data = await subscriptionService.listSubscriptions({ page, limit });
  res.json(data);
});

export const getMySubscriptionStatus = asyncHandler(async (req: Request, res: Response) => {
  const data = await subscriptionService.getUserSubscriptionStatus(req.auth!.id);
  res.json(data);
});

export const getSubscriptionDetails = asyncHandler(async (req: Request, res: Response) => {
  const subscription = await subscriptionService.getSubscriptionById(req.params.id as string);
  if (!subscription) {
    return res.status(404).json({ message: 'Subscription not found' });
  }
  res.json(subscription);
});

export const updateSubscriptionStatus = [
  body('status').isIn(['paid', 'free']),
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const updated = await subscriptionService.updateSubscriptionStatus({
      subscriptionId: req.params.id as string,
      status: req.body.status
    });
    res.json(updated);
  })
];

export const updateUserSubscriptionStatus = [
  body('status').isIn(['paid', 'free']),
  body('planType')
    .optional()
    .isIn(Object.values(PLAN_TYPES)),
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const updated = await subscriptionService.updateUserSubscriptionStatus({
      userId: req.params.userId as string,
      status: req.body.status,
      planType: req.body.planType
    });
    res.json(updated);
  })
];
