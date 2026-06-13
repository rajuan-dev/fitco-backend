import { Router } from 'express';
import {
  appleWebhook,
  createCheckoutSession,
  getSubscriptionStatus,
  getMySubscriptionStatus,
  getSubscriptionDetails,
  getSubscriptionQuote,
  googleWebhook,
  listPlans,
  listSubscriptions,
  revenueCatWebhook,
  syncRevenueCatPurchase,
  updateSubscriptionStatus,
  updateUserSubscriptionStatus,
  verifyApplePurchase,
  verifyGooglePurchase
} from './controller';
import { authenticate, authorizeRoles } from '../../middlewares/authMiddleware';
import { ROLES } from '../../utils/constants';

const router = Router();

router.get('/plans', authenticate, authorizeRoles(ROLES.USER), listPlans);
router.post('/apple/verify', authenticate, authorizeRoles(ROLES.USER), verifyApplePurchase);
router.post('/google/verify', authenticate, authorizeRoles(ROLES.USER), verifyGooglePurchase);
router.post('/revenuecat/sync', authenticate, authorizeRoles(ROLES.USER), syncRevenueCatPurchase);
router.get('/status', authenticate, authorizeRoles(ROLES.USER), getSubscriptionStatus);
router.post('/apple/webhook', appleWebhook);
router.post('/google/webhook', googleWebhook);
router.post('/revenuecat-webhook', revenueCatWebhook);
router.get('/me/status', authenticate, authorizeRoles(ROLES.USER), getMySubscriptionStatus);
router.post('/quote', authenticate, authorizeRoles(ROLES.USER), getSubscriptionQuote);
router.post('/checkout-session', authenticate, authorizeRoles(ROLES.USER), createCheckoutSession);
router.post('/', authenticate, authorizeRoles(ROLES.USER), createCheckoutSession);
router.get('/', authenticate, authorizeRoles(ROLES.ADMIN), listSubscriptions);
router.patch('/user/:userId/status', authenticate, authorizeRoles(ROLES.ADMIN), updateUserSubscriptionStatus);
router.get('/:id', authenticate, authorizeRoles(ROLES.ADMIN), getSubscriptionDetails);
router.patch('/:id/status', authenticate, authorizeRoles(ROLES.ADMIN), updateSubscriptionStatus);

export default router;
