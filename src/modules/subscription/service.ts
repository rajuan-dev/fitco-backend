import Stripe from 'stripe';
import stripe from '../../config/stripe';
import config from '../../config';
import SubscriptionModel, { SubscriptionDocument } from './model';
import SubscriptionPricingModel from './pricing.model';
import TransactionModel from './transaction.model';
import UserModel from '../user/model';
import * as couponService from '../coupon/service';
import { PLAN_TYPES, SUBSCRIPTION_STATUS, PlanType, SubscriptionStatus } from '../../utils/constants';
import {
  AppleCatalogPrice,
  getAppleSubscriptionPrice,
  AppleVerifiedSubscription,
  parseAppleWebhookPayload,
  verifyAppleReceipt,
  verifyAppleTransaction
} from './apple.service';
import {
  acknowledgeGoogleSubscription,
  getGoogleBasePlanPrice,
  GoogleCatalogPrice,
  GoogleVerifiedSubscription,
  parseGoogleWebhookPayload,
  verifyGooglePurchase
} from './google.service';
import { convertAmountToSar, normalizeCurrencyCode, REPORTING_CURRENCY } from '../../utils/currency';

interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

interface ListParams {
  page?: number | string;
  limit?: number | string;
}

interface CreateCheckoutSessionInput {
  userId: string;
  planType: PlanType;
  couponCode?: string;
}

interface QuoteInput {
  planType: PlanType;
  couponCode?: string;
}

interface PricingContext {
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency: string;
}

interface PlanPrice {
  planType: PlanType;
  interval: 'month' | 'year';
  label: string;
  prices: {
    admin: {
      amount: number;
      amountCents: number;
      currency: string;
    };
    apple: {
      amount: number | null;
      currency: string | null;
    };
    google: {
      amount: number | null;
      currency: string | null;
    };
  };
}

interface QuoteResult {
  planType: PlanType;
  basePrice: number;
  basePriceCents: number;
  finalPrice: number;
  finalPriceCents: number;
  discountAmount: number;
  discountAmountCents: number;
  discountPercentage: number;
  couponCode?: string;
  currency: string;
}

interface PricingSettingsResponse {
  monthlyPriceCents: number;
  yearlyPriceCents: number;
  currency: string;
  updatedAt: Date;
}

type ManualSubscriptionStatus = 'paid' | 'free';
type SubscriptionPlatform = 'stripe' | 'apple' | 'google';

interface NormalizedSubscriptionResult {
  subscription: SubscriptionDocument;
  normalized: {
    userId: string;
    platform: Exclude<SubscriptionPlatform, 'stripe'>;
    productId: string;
    basePlanId?: string;
    transactionId?: string;
    purchaseToken?: string;
    expiryDate: Date;
    status: SubscriptionStatus;
    isActive: boolean;
  };
}

interface ExternalPriceResolution {
  reportingPrice: {
    amount: number;
    currency: string;
  };
  customerPrice?: {
    amount: number;
    currency: string;
    region?: string;
  } | null;
}

const createHttpError = (message: string, statusCode: number): Error & { statusCode: number } => {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
};

const centsToAmount = (value: number): number => Number((value / 100).toFixed(2));

const stripNilValues = <T extends Record<string, unknown>>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)) as Partial<T>;

const parsePlanInterval = (planType: PlanType): 'month' | 'year' => (planType === PLAN_TYPES.YEARLY ? 'year' : 'month');

const getPlanPriceCents = (planType: PlanType, pricing: PricingContext): number => {
  if (planType === PLAN_TYPES.YEARLY) {
    return pricing.yearlyPriceCents;
  }
  return pricing.monthlyPriceCents;
};

const buildPlanPrice = ({
  planType,
  pricing,
  applePrice,
  googlePrice
}: {
  planType: PlanType;
  pricing: PricingContext;
  applePrice: AppleCatalogPrice | null;
  googlePrice: GoogleCatalogPrice | null;
}): PlanPrice => {
  const priceCents = getPlanPriceCents(planType, pricing);

  return {
    planType,
    interval: parsePlanInterval(planType),
    label: planType === PLAN_TYPES.YEARLY ? 'Yearly Plan' : 'Monthly Plan',
    prices: {
      admin: {
        amount: centsToAmount(priceCents),
        amountCents: priceCents,
        currency: pricing.currency
      },
      apple: {
        amount: applePrice?.amount ?? null,
        currency: applePrice?.currency ?? null
      },
      google: {
        amount: googlePrice?.amount ?? null,
        currency: googlePrice?.currency ?? null
      }
    }
  };
};

const getApplePriceForPlan = async (planType: PlanType): Promise<AppleCatalogPrice | null> => {
  const subscriptionIds =
    planType === PLAN_TYPES.YEARLY ? config.apple.yearlySubscriptionIds : config.apple.monthlySubscriptionIds;
  const subscriptionId = subscriptionIds[0];

  if (!subscriptionId) {
    return null;
  }

  try {
    return await getAppleSubscriptionPrice({
      subscriptionId,
      territory: config.apple.priceTerritory
    });
  } catch {
    return null;
  }
};

const getGooglePriceForPlan = async (planType: PlanType): Promise<GoogleCatalogPrice | null> => {
  const productIds = planType === PLAN_TYPES.YEARLY ? config.google.yearlyProductIds : config.google.monthlyProductIds;
  const basePlanIds =
    planType === PLAN_TYPES.YEARLY ? config.google.yearlyBasePlanIds : config.google.monthlyBasePlanIds;
  const productId = productIds[0];
  const basePlanId = basePlanIds[0];

  if (!productId || !basePlanId) {
    return null;
  }

  try {
    return await getGoogleBasePlanPrice({
      productId,
      basePlanId,
      region: config.google.priceRegion
    });
  } catch {
    return null;
  }
};

const getAppleSubscriptionIdForProduct = (productId: string): string | null => {
  const monthlyIndex = config.apple.monthlyProductIds.indexOf(productId);
  if (monthlyIndex >= 0) {
    return config.apple.monthlySubscriptionIds[monthlyIndex] || config.apple.monthlySubscriptionIds[0] || null;
  }

  const yearlyIndex = config.apple.yearlyProductIds.indexOf(productId);
  if (yearlyIndex >= 0) {
    return config.apple.yearlySubscriptionIds[yearlyIndex] || config.apple.yearlySubscriptionIds[0] || null;
  }

  return null;
};

const getApplePriceForVerifiedSubscription = async ({
  productId,
  planType
}: {
  productId: string;
  planType: PlanType;
}): Promise<AppleCatalogPrice | null> => {
  const subscriptionId = getAppleSubscriptionIdForProduct(productId);
  if (subscriptionId) {
    try {
      return await getAppleSubscriptionPrice({
        subscriptionId,
        territory: config.apple.priceTerritory
      });
    } catch {
      return getApplePriceForPlan(planType);
    }
  }

  return getApplePriceForPlan(planType);
};

const getGooglePriceForVerifiedSubscription = async ({
  productId,
  basePlanId,
  planType,
  region
}: {
  productId: string;
  basePlanId?: string;
  planType: PlanType;
  region?: string;
}): Promise<GoogleCatalogPrice | null> => {
  if (basePlanId) {
    try {
      return await getGoogleBasePlanPrice({
        productId,
        basePlanId,
        region: region || config.google.priceRegion
      });
    } catch {
      return getGooglePriceForPlan(planType);
    }
  }

  return getGooglePriceForPlan(planType);
};

const getAdminReportingPrice = async (planType: PlanType): Promise<GoogleCatalogPrice> => {
  const pricing = await getPricingContext();
  const amountCents = getPlanPriceCents(planType, pricing);

  return {
    amount: centsToAmount(amountCents),
    currency: pricing.currency.toUpperCase(),
    region: config.google.priceRegion
  };
};

const resolveSarReportingPrice = async ({
  customerPrice,
  fallbackPrice
}: {
  customerPrice?: {
    amount: number;
    currency: string;
  } | null;
  fallbackPrice: {
    amount: number;
    currency: string;
  };
}): Promise<{ amount: number; currency: string }> => {
  const priceToConvert = customerPrice || fallbackPrice;

  try {
    return {
      amount: await convertAmountToSar({
        amount: priceToConvert.amount,
        fromCurrency: priceToConvert.currency
      }),
      currency: REPORTING_CURRENCY
    };
  } catch {
    if (normalizeCurrencyCode(fallbackPrice.currency) === REPORTING_CURRENCY) {
      return {
        amount: fallbackPrice.amount,
        currency: REPORTING_CURRENCY
      };
    }

    return {
      amount: priceToConvert.amount,
      currency: priceToConvert.currency.toUpperCase()
    };
  }
};

const resolveGoogleTransactionPrices = async ({
  productId,
  basePlanId,
  planType,
  region
}: {
  productId: string;
  basePlanId?: string;
  planType: PlanType;
  region?: string;
}): Promise<ExternalPriceResolution | null> => {
  const reportingPrice =
    (await getGooglePriceForVerifiedSubscription({
      productId,
      basePlanId,
      planType,
      region: config.google.priceRegion
    })) || (await getAdminReportingPrice(planType));

  let customerPrice: GoogleCatalogPrice | null = null;
  if (basePlanId && region && region !== config.google.priceRegion) {
    try {
      customerPrice = await getGoogleBasePlanPrice({
        productId,
        basePlanId,
        region
      });
    } catch {
      customerPrice = null;
    }
  }

  const reportingPriceInSar = await resolveSarReportingPrice({
    customerPrice,
    fallbackPrice: {
      amount: reportingPrice.amount,
      currency: reportingPrice.currency
    }
  });

  return {
    reportingPrice: reportingPriceInSar,
    customerPrice: customerPrice
      ? {
          amount: customerPrice.amount,
          currency: customerPrice.currency,
          region: customerPrice.region
        }
      : null
  };
};

const calculateExpiryByPlan = (planType: PlanType): Date => {
  const now = new Date();
  if (planType === PLAN_TYPES.YEARLY) {
    now.setFullYear(now.getFullYear() + 1);
    return now;
  }
  now.setMonth(now.getMonth() + 1);
  return now;
};

const resolvePlanTypeForProduct = (
  productId: string,
  platform: Exclude<SubscriptionPlatform, 'stripe'>
): PlanType => {
  const productIdSets =
    platform === 'apple'
      ? {
          monthly: config.apple.monthlyProductIds,
          yearly: config.apple.yearlyProductIds
        }
      : {
          monthly: config.google.monthlyProductIds,
          yearly: config.google.yearlyProductIds
        };

  if (productIdSets.monthly.includes(productId)) {
    return PLAN_TYPES.MONTHLY;
  }
  if (productIdSets.yearly.includes(productId)) {
    return PLAN_TYPES.YEARLY;
  }

  throw createHttpError(`Unsupported ${platform} subscription product: ${productId}`, 400);
};

const resolvePlanTypeForGoogleIdentifiers = ({
  productId,
  basePlanId
}: {
  productId: string;
  basePlanId?: string;
}): PlanType => {
  if (basePlanId) {
    if (config.google.monthlyBasePlanIds.includes(basePlanId)) {
      return PLAN_TYPES.MONTHLY;
    }
    if (config.google.yearlyBasePlanIds.includes(basePlanId)) {
      return PLAN_TYPES.YEARLY;
    }
  }

  return resolvePlanTypeForProduct(productId, 'google');
};

const toExpiryStatus = (expiryDate: Date, revokedAt?: Date | null): SubscriptionStatus => {
  if (revokedAt || expiryDate <= new Date()) {
    return SUBSCRIPTION_STATUS.EXPIRED;
  }
  return SUBSCRIPTION_STATUS.ACTIVE;
};

const ensureValidPlanType = (planType: PlanType): void => {
  if (!Object.values(PLAN_TYPES).includes(planType)) {
    const error = new Error('Invalid plan type');
    (error as any).statusCode = 400;
    throw error;
  }
};

const getOrCreatePricingSettings = async () => {
  let settings = await SubscriptionPricingModel.findOne({ key: 'default' });
  if (!settings) {
    settings = await SubscriptionPricingModel.create({
      key: 'default',
      monthlyPriceCents: config.stripe.monthlyPriceCents,
      yearlyPriceCents: config.stripe.yearlyPriceCents,
      currency: config.stripe.currency
    });
  }
  return settings;
};

const getPricingContext = async (): Promise<PricingContext> => {
  const settings = await getOrCreatePricingSettings();
  return {
    monthlyPriceCents: settings.monthlyPriceCents,
    yearlyPriceCents: settings.yearlyPriceCents,
    currency: settings.currency
  };
};

const expireLapsedSubscriptions = async (): Promise<void> => {
  await SubscriptionModel.updateMany(
    { expiryDate: { $lt: new Date() }, status: SUBSCRIPTION_STATUS.ACTIVE },
    { status: SUBSCRIPTION_STATUS.EXPIRED, isActive: false }
  );
};

const ensureStripeConfigured = (mode: 'checkout' | 'webhook'): void => {
  if (!config.stripe.secretKey) {
    const error = new Error('Stripe is not configured. Missing STRIPE_SECRET_KEY');
    (error as any).statusCode = 400;
    throw error;
  }
  if (mode === 'webhook' && !config.stripe.webhookSecret) {
    const error = new Error('Stripe webhook is not configured. Missing STRIPE_WEBHOOK_SECRET');
    (error as any).statusCode = 400;
    throw error;
  }
};

const getQuoteInternal = async ({ planType, couponCode }: QuoteInput): Promise<QuoteResult> => {
  ensureValidPlanType(planType);
  const pricing = await getPricingContext();

  const basePriceCents = getPlanPriceCents(planType, pricing);
  let finalPriceCents = basePriceCents;
  let discountPercentage = 0;
  let discountAmountCents = 0;
  let appliedCouponCode: string | undefined;

  if (couponCode) {
    const coupon = await couponService.getCouponByCode(couponCode);
    if (!coupon) {
      const error = new Error('Invalid coupon');
      (error as any).statusCode = 400;
      throw error;
    }
    discountPercentage = coupon.discountPercentage;
    discountAmountCents = Math.round(basePriceCents * (discountPercentage / 100));
    finalPriceCents = Math.max(basePriceCents - discountAmountCents, 1);
    appliedCouponCode = coupon.code;
  }

  return {
    planType,
    basePrice: centsToAmount(basePriceCents),
    basePriceCents,
    finalPrice: centsToAmount(finalPriceCents),
    finalPriceCents,
    discountAmount: centsToAmount(discountAmountCents),
    discountAmountCents,
    discountPercentage,
    couponCode: appliedCouponCode,
    currency: pricing.currency
  };
};

const getOrCreateStripeCustomer = async (userId: string): Promise<{ user: any; stripeCustomerId: string }> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    (error as any).statusCode = 404;
    throw error;
  }

  if (user.stripeCustomerId) {
    return { user, stripeCustomerId: user.stripeCustomerId };
  }

  const customer = await stripe.customers.create({
    email: user.email,
    name: user.name,
    metadata: { userId: user._id.toString() }
  });
  user.stripeCustomerId = customer.id;
  await user.save();
  return { user, stripeCustomerId: customer.id };
};

const resolveUserForWebhook = async (userId?: string, stripeCustomerId?: string): Promise<any | null> => {
  if (userId) {
    const byId = await UserModel.findById(userId);
    if (byId) return byId;
  }
  if (stripeCustomerId) {
    return UserModel.findOne({ stripeCustomerId });
  }
  return null;
};

const getPlanTypeFromStripeInterval = (interval?: string | null): PlanType => {
  if (interval === 'year') {
    return PLAN_TYPES.YEARLY;
  }
  return PLAN_TYPES.MONTHLY;
};

const toSubscriptionStatus = (stripeStatus: Stripe.Subscription.Status): SubscriptionStatus => {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    return SUBSCRIPTION_STATUS.ACTIVE;
  }
  return SUBSCRIPTION_STATUS.EXPIRED;
};

const syncUserSubscriptionStatus = async (userId: string): Promise<void> => {
  const active = await SubscriptionModel.exists({
    user: userId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    isActive: true,
    expiryDate: { $gt: new Date() }
  });
  await UserModel.findByIdAndUpdate(userId, { subscriptionStatus: active ? 'premium' : 'free' });
};

const upsertExternalTransaction = async (params: {
  userId: string;
  platform: 'apple' | 'google';
  planType: PlanType;
  amount: number;
  reference: string;
  productId: string;
  currency?: string;
  meta?: Record<string, unknown>;
}): Promise<void> => {
  const normalizedCurrency = normalizeCurrencyCode(params.currency);
  const originalAmount =
    typeof params.meta?.originalAmount === 'number' && Number.isFinite(params.meta.originalAmount)
      ? params.meta.originalAmount
      : params.amount;
  const originalCurrency =
    normalizeCurrencyCode(
      typeof params.meta?.originalCurrency === 'string' ? params.meta.originalCurrency : normalizedCurrency
    ) || normalizedCurrency;

  let reportingAmount =
    typeof params.meta?.reportingAmount === 'number' && Number.isFinite(params.meta.reportingAmount)
      ? params.meta.reportingAmount
      : null;
  let reportingCurrency = normalizeCurrencyCode(
    typeof params.meta?.reportingCurrency === 'string' ? params.meta.reportingCurrency : undefined
  );

  if (reportingAmount === null && originalCurrency) {
    try {
      reportingAmount = await convertAmountToSar({
        amount: originalAmount,
        fromCurrency: originalCurrency
      });
      reportingCurrency = REPORTING_CURRENCY;
    } catch {
      reportingAmount = normalizeCurrencyCode(originalCurrency) === REPORTING_CURRENCY ? originalAmount : null;
      reportingCurrency = reportingAmount !== null ? REPORTING_CURRENCY : null;
    }
  }

  const normalizedMeta = stripNilValues({
    ...(params.meta || {}),
    originalAmount: Number.isFinite(originalAmount) ? originalAmount : undefined,
    originalCurrency: originalCurrency || undefined,
    reportingAmount: reportingAmount ?? undefined,
    reportingCurrency: reportingCurrency || undefined
  });

  const existing = await TransactionModel.findOne({ reference: params.reference });
  if (existing) {
    existing.amount = params.amount;
    existing.planType = params.planType;
    existing.platform = params.platform;
    existing.status = 'paid';
    existing.productId = params.productId;
    existing.currency = normalizedCurrency || existing.currency;
    existing.meta = {
      ...(existing.meta || {}),
      ...normalizedMeta
    };
    await existing.save();
    return;
  }

  await TransactionModel.create({
    user: params.userId,
    amount: params.amount,
    planType: params.planType,
    platform: params.platform,
    status: 'paid',
    reference: params.reference,
    productId: params.productId,
    currency: normalizedCurrency || undefined,
    meta: normalizedMeta
  });
};

const upsertLocalSubscription = async (params: {
  userId: string;
  planType: PlanType;
  price: number;
  expiryDate: Date;
  couponCode?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  status?: SubscriptionStatus;
}): Promise<SubscriptionDocument> => {
  const payload = {
    user: params.userId,
    platform: 'stripe' as const,
    planType: params.planType,
    price: params.price,
    expiryDate: params.expiryDate,
    isActive: (params.status || SUBSCRIPTION_STATUS.ACTIVE) === SUBSCRIPTION_STATUS.ACTIVE,
    couponCode: params.couponCode,
    stripeCustomerId: params.stripeCustomerId,
    stripeSubscriptionId: params.stripeSubscriptionId,
    stripeCheckoutSessionId: params.stripeCheckoutSessionId,
    status: params.status || SUBSCRIPTION_STATUS.ACTIVE
  };

  if (params.stripeSubscriptionId) {
    const updated = await SubscriptionModel.findOneAndUpdate(
      { stripeSubscriptionId: params.stripeSubscriptionId },
      payload,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    return updated;
  }

  return SubscriptionModel.create(payload);
};

const upsertExternalSubscription = async (params: {
  userId: string;
  platform: Exclude<SubscriptionPlatform, 'stripe'>;
  productId: string;
  planType: PlanType;
  expiryDate: Date;
  transactionId?: string;
  purchaseToken?: string;
  providerSubscriptionId?: string;
  providerPayload: Record<string, unknown>;
}): Promise<SubscriptionDocument> => {
  const status = toExpiryStatus(params.expiryDate);
  const identifiers = [
    ...(params.transactionId ? [{ transactionId: params.transactionId }] : []),
    ...(params.purchaseToken ? [{ purchaseToken: params.purchaseToken }] : []),
    ...(params.providerSubscriptionId ? [{ providerSubscriptionId: params.providerSubscriptionId }] : [])
  ];

  if (!identifiers.length) {
    throw createHttpError(`Missing ${params.platform} subscription identifier`, 400);
  }

  if (params.platform === 'google') {
    await SubscriptionModel.updateMany({ platform: 'google', transactionId: null }, { $unset: { transactionId: 1 } });
  }

  const payload = stripNilValues({
    user: params.userId,
    platform: params.platform,
    productId: params.productId,
    planType: params.planType,
    price: 0,
    expiryDate: params.expiryDate,
    status,
    isActive: status === SUBSCRIPTION_STATUS.ACTIVE,
    transactionId: params.transactionId,
    purchaseToken: params.purchaseToken,
    providerSubscriptionId: params.providerSubscriptionId,
    providerPayload: params.providerPayload
  });

  const existing = await SubscriptionModel.findOne({
    platform: params.platform,
    $or: identifiers
  });

  if (existing) {
    Object.assign(existing, payload);
    await existing.save();
    return existing;
  }

  return SubscriptionModel.create(payload);
};

const handleCheckoutSessionCompleted = async (session: Stripe.Checkout.Session): Promise<void> => {
  if (session.mode !== 'subscription') {
    return;
  }
  const stripeSubscriptionId = typeof session.subscription === 'string' ? session.subscription : undefined;
  const stripeCustomerId = typeof session.customer === 'string' ? session.customer : undefined;
  if (!stripeSubscriptionId || !stripeCustomerId) {
    return;
  }

  const user = await resolveUserForWebhook(session.metadata?.userId, stripeCustomerId);
  if (!user) {
    const error = new Error('Unable to resolve user for Stripe checkout session');
    (error as any).statusCode = 400;
    throw error;
  }

  const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const interval = (stripeSubscription as any).items?.data?.[0]?.price?.recurring?.interval as string | undefined;
  const planType = (session.metadata?.planType as PlanType) || getPlanTypeFromStripeInterval(interval);
  const finalPriceCents = Number(session.metadata?.finalPriceCents || session.amount_total || 0);
  const finalPrice = centsToAmount(finalPriceCents);
  const couponCode = session.metadata?.couponCode || undefined;
  const currentPeriodEnd = (stripeSubscription as any).current_period_end as number | undefined;
  const expiryDate = currentPeriodEnd
    ? new Date(currentPeriodEnd * 1000)
    : calculateExpiryByPlan(planType);

  await upsertLocalSubscription({
    userId: user._id.toString(),
    planType,
    price: finalPrice,
    expiryDate,
    couponCode,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeCheckoutSessionId: session.id,
    status: toSubscriptionStatus((stripeSubscription as any).status as Stripe.Subscription.Status)
  });

  const reference = `stripe_cs_${session.id}`;
  const existing = await TransactionModel.findOne({ reference });
  if (!existing) {
    const stripeCurrency = normalizeCurrencyCode(session.currency || config.stripe.currency);
    let reportingAmount: number | undefined;
    if (stripeCurrency) {
      try {
        reportingAmount = await convertAmountToSar({
          amount: finalPrice,
          fromCurrency: stripeCurrency
        });
      } catch {
        reportingAmount = stripeCurrency === REPORTING_CURRENCY ? finalPrice : undefined;
      }
    }

    await TransactionModel.create({
      user: user._id,
      amount: finalPrice,
      planType,
      platform: 'stripe',
      status: 'paid',
      reference,
      couponCode,
      currency: stripeCurrency || undefined,
      stripeCheckoutSessionId: session.id,
      stripeSubscriptionId,
      meta: {
        stripeCustomerId,
        originalAmount: finalPrice,
        originalCurrency: stripeCurrency || undefined,
        reportingAmount,
        reportingCurrency: reportingAmount !== undefined ? REPORTING_CURRENCY : undefined
      }
    });
  }

  await UserModel.findByIdAndUpdate(user._id, {
    subscriptionStatus: 'premium',
    stripeCustomerId
  });
};

const handleInvoicePaymentSucceeded = async (invoice: Stripe.Invoice): Promise<void> => {
  const invoiceSubscription = (invoice as any).subscription as string | undefined;
  const stripeSubscriptionId = typeof invoiceSubscription === 'string' ? invoiceSubscription : undefined;
  const stripeCustomerId = typeof invoice.customer === 'string' ? invoice.customer : undefined;
  if (!stripeSubscriptionId || !stripeCustomerId) {
    return;
  }

  const stripeSubscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
  const interval = (stripeSubscription as any).items?.data?.[0]?.price?.recurring?.interval as string | undefined;
  const planType = getPlanTypeFromStripeInterval(interval);
  const amountPaid = centsToAmount(invoice.amount_paid || 0);
  const currentPeriodEnd = (stripeSubscription as any).current_period_end as number | undefined;
  const expiryDate = currentPeriodEnd
    ? new Date(currentPeriodEnd * 1000)
    : calculateExpiryByPlan(planType);

  let localSubscription = (await SubscriptionModel.findOne({
    stripeSubscriptionId
  })) as unknown as SubscriptionDocument | null;
  let userId: string | undefined = localSubscription?.user?.toString();
  if (!userId) {
    const resolvedUser = await resolveUserForWebhook(undefined, stripeCustomerId);
    userId = resolvedUser?._id?.toString();
  }
  if (!userId) {
    return;
  }

  localSubscription = await upsertLocalSubscription({
    userId,
    planType,
    price: amountPaid,
    expiryDate,
    stripeCustomerId,
    stripeSubscriptionId,
    status: toSubscriptionStatus((stripeSubscription as any).status as Stripe.Subscription.Status)
  });
  if (!localSubscription) {
    return;
  }

  const reference = `stripe_inv_${invoice.id}`;
  const existing = await TransactionModel.findOne({ reference });
  if (!existing) {
    const stripeCurrency = normalizeCurrencyCode(invoice.currency || config.stripe.currency);
    let reportingAmount: number | undefined;
    if (stripeCurrency) {
      try {
        reportingAmount = await convertAmountToSar({
          amount: amountPaid,
          fromCurrency: stripeCurrency
        });
      } catch {
        reportingAmount = stripeCurrency === REPORTING_CURRENCY ? amountPaid : undefined;
      }
    }

    await TransactionModel.create({
      user: localSubscription.user,
      amount: amountPaid,
      planType,
      platform: 'stripe',
      status: 'paid',
      reference,
      currency: stripeCurrency || undefined,
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId,
      meta: {
        stripeCustomerId,
        originalAmount: amountPaid,
        originalCurrency: stripeCurrency || undefined,
        reportingAmount,
        reportingCurrency: reportingAmount !== undefined ? REPORTING_CURRENCY : undefined
      }
    });
  }

  await syncUserSubscriptionStatus(userId);
};

const handleInvoicePaymentFailed = async (invoice: Stripe.Invoice): Promise<void> => {
  const invoiceSubscription = (invoice as any).subscription as string | undefined;
  const stripeSubscriptionId = typeof invoiceSubscription === 'string' ? invoiceSubscription : undefined;
  if (!stripeSubscriptionId) {
    return;
  }

  const localSubscription = (await SubscriptionModel.findOne({
    stripeSubscriptionId
  })) as unknown as SubscriptionDocument | null;
  if (!localSubscription) {
    return;
  }

  const reference = `stripe_inv_failed_${invoice.id}`;
  const existing = await TransactionModel.findOne({ reference });
  if (!existing) {
    await TransactionModel.create({
      user: localSubscription.user,
      amount: centsToAmount(invoice.amount_due || 0),
      planType: localSubscription.planType,
      platform: 'stripe',
      status: 'failed',
      reference,
      stripeInvoiceId: invoice.id,
      stripeSubscriptionId
    });
  }
};

const handleSubscriptionStateChanged = async (subscription: Stripe.Subscription): Promise<void> => {
  const stripeSubscriptionId = subscription.id;
  const local = (await SubscriptionModel.findOne({
    stripeSubscriptionId
  })) as unknown as SubscriptionDocument | null;
  if (!local) {
    return;
  }

  const nextStatus = toSubscriptionStatus(subscription.status);
  const currentPeriodEnd = (subscription as any).current_period_end as number | undefined;
  const nextExpiry = currentPeriodEnd
    ? new Date(currentPeriodEnd * 1000)
    : local.expiryDate;

  local.status = nextStatus;
  local.expiryDate = nextExpiry;
  local.isActive = nextStatus === SUBSCRIPTION_STATUS.ACTIVE && nextExpiry > new Date();
  await local.save();
  await syncUserSubscriptionStatus(local.user.toString());
};

export const getPlans = async (): Promise<PlanPrice[]> => {
  const pricing = await getPricingContext();
  const [monthlyApplePrice, yearlyApplePrice, monthlyGooglePrice, yearlyGooglePrice] = await Promise.all([
    getApplePriceForPlan(PLAN_TYPES.MONTHLY),
    getApplePriceForPlan(PLAN_TYPES.YEARLY),
    getGooglePriceForPlan(PLAN_TYPES.MONTHLY),
    getGooglePriceForPlan(PLAN_TYPES.YEARLY)
  ]);

  return [
    buildPlanPrice({
      planType: PLAN_TYPES.MONTHLY,
      pricing,
      applePrice: monthlyApplePrice,
      googlePrice: monthlyGooglePrice
    }),
    buildPlanPrice({
      planType: PLAN_TYPES.YEARLY,
      pricing,
      applePrice: yearlyApplePrice,
      googlePrice: yearlyGooglePrice
    })
  ];
};

export const getPricingSettings = async (): Promise<PricingSettingsResponse> => {
  const settings = await getOrCreatePricingSettings();
  return {
    monthlyPriceCents: settings.monthlyPriceCents,
    yearlyPriceCents: settings.yearlyPriceCents,
    currency: settings.currency,
    updatedAt: settings.updatedAt
  };
};

export const updatePricingSettings = async (input: {
  monthlyPriceCents?: number;
  yearlyPriceCents?: number;
  currency?: string;
  adminId: string;
}): Promise<PricingSettingsResponse> => {
  const settings = await getOrCreatePricingSettings();

  if (input.monthlyPriceCents !== undefined) {
    settings.monthlyPriceCents = input.monthlyPriceCents;
  }
  if (input.yearlyPriceCents !== undefined) {
    settings.yearlyPriceCents = input.yearlyPriceCents;
  }
  if (input.currency !== undefined) {
    settings.currency = input.currency;
  }
  settings.updatedBy = input.adminId as any;
  await settings.save();

  return {
    monthlyPriceCents: settings.monthlyPriceCents,
    yearlyPriceCents: settings.yearlyPriceCents,
    currency: settings.currency,
    updatedAt: settings.updatedAt
  };
};

export const getSubscriptionQuote = async ({ planType, couponCode }: QuoteInput): Promise<QuoteResult> => {
  return getQuoteInternal({ planType, couponCode });
};

export const createCheckoutSession = async ({
  userId,
  planType,
  couponCode
}: CreateCheckoutSessionInput): Promise<{
  checkoutSessionId: string;
  checkoutUrl: string | null;
  quote: QuoteResult;
}> => {
  ensureStripeConfigured('checkout');
  ensureValidPlanType(planType);

  const quote = await getQuoteInternal({ planType, couponCode });
  const { stripeCustomerId } = await getOrCreateStripeCustomer(userId);

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: stripeCustomerId,
    success_url: config.stripe.successUrl,
    cancel_url: config.stripe.cancelUrl,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: quote.currency,
          unit_amount: quote.finalPriceCents,
          recurring: { interval: parsePlanInterval(planType) },
          product_data: {
            name: planType === PLAN_TYPES.YEARLY ? 'Fitco Premium Yearly' : 'Fitco Premium Monthly'
          }
        }
      }
    ],
    metadata: {
      userId,
      planType,
      basePriceCents: String(quote.basePriceCents),
      finalPriceCents: String(quote.finalPriceCents),
      discountPercentage: String(quote.discountPercentage),
      couponCode: quote.couponCode || ''
    }
  });

  return {
    checkoutSessionId: session.id,
    checkoutUrl: session.url,
    quote
  };
};

export const processStripeWebhook = async (payload: Buffer, signature: string): Promise<Stripe.Event> => {
  ensureStripeConfigured('webhook');
  const event = stripe.webhooks.constructEvent(payload, signature, config.stripe.webhookSecret);

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoicePaymentSucceeded(event.data.object as Stripe.Invoice);
      break;
    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await handleSubscriptionStateChanged(event.data.object as Stripe.Subscription);
      break;
    default:
      break;
  }

  return event;
};

const normalizeAppleSubscription = async (
  userId: string,
  verified: AppleVerifiedSubscription
): Promise<NormalizedSubscriptionResult> => {
  const planType = resolvePlanTypeForProduct(verified.productId, 'apple');
  const catalogPrice = await getApplePriceForVerifiedSubscription({
    productId: verified.productId,
    planType
  });
  const subscription = await upsertExternalSubscription({
    userId,
    platform: 'apple',
    productId: verified.productId,
    planType,
    expiryDate: verified.expiryDate,
    transactionId: verified.transactionId,
    providerSubscriptionId: verified.originalTransactionId,
    providerPayload: {
      originalTransactionId: verified.originalTransactionId,
      purchaseDate: verified.purchaseDate?.toISOString(),
      revokedAt: verified.revokedAt?.toISOString(),
      environment: verified.environment
    }
  });

  if (subscription.isActive && catalogPrice?.amount) {
    await upsertExternalTransaction({
      userId,
      platform: 'apple',
      planType,
      amount: catalogPrice.amount,
      currency: catalogPrice.currency,
      productId: verified.productId,
      reference: `apple_tx_${verified.transactionId}`,
      meta: {
        transactionId: verified.transactionId,
        originalTransactionId: verified.originalTransactionId,
        territory: catalogPrice.territory,
        purchaseDate: verified.purchaseDate?.toISOString(),
        expiryDate: verified.expiryDate.toISOString(),
        environment: verified.environment
      }
    });
  }

  await syncUserSubscriptionStatus(userId);

  return {
    subscription,
    normalized: {
      userId,
      platform: 'apple',
      productId: verified.productId,
      transactionId: verified.transactionId,
      expiryDate: verified.expiryDate,
      status: subscription.status,
      isActive: subscription.isActive
    }
  };
};

const normalizeGoogleSubscription = async (
  userId: string,
  verified: GoogleVerifiedSubscription
): Promise<NormalizedSubscriptionResult> => {
  try {
    await acknowledgeGoogleSubscription({
      productId: verified.productId,
      purchaseToken: verified.purchaseToken
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google purchase acknowledgement failed';
    throw createHttpError(message, 400);
  }

  const planType = resolvePlanTypeForGoogleIdentifiers({
    productId: verified.productId,
    basePlanId: verified.basePlanId
  });
  const priceResolution = await resolveGoogleTransactionPrices({
    productId: verified.productId,
    basePlanId: verified.basePlanId,
    planType,
    region: verified.regionCode
  });
  const subscription = await upsertExternalSubscription({
    userId,
    platform: 'google',
    productId: verified.productId,
    planType,
    expiryDate: verified.expiryDate,
    purchaseToken: verified.purchaseToken,
    providerSubscriptionId: verified.providerSubscriptionId,
    providerPayload: {
      basePlanId: verified.basePlanId,
      subscriptionState: verified.subscriptionState,
      autoRenewing: verified.autoRenewing,
      latestOrderId: verified.latestOrderId,
      startDate: verified.startDate?.toISOString(),
      regionCode: verified.regionCode
    }
  });

  if (subscription.isActive && priceResolution?.reportingPrice.amount) {
    await upsertExternalTransaction({
      userId,
      platform: 'google',
      planType,
      amount: priceResolution.reportingPrice.amount,
      currency: priceResolution.reportingPrice.currency,
      productId: verified.productId,
      reference: verified.latestOrderId ? `google_order_${verified.latestOrderId}` : `google_purchase_${verified.purchaseToken}`,
      meta: {
        originalAmount: priceResolution.customerPrice?.amount ?? priceResolution.reportingPrice.amount,
        originalCurrency: priceResolution.customerPrice?.currency ?? priceResolution.reportingPrice.currency,
        originalRegion: priceResolution.customerPrice?.region ?? verified.regionCode ?? config.google.priceRegion,
        reportingAmount: priceResolution.reportingPrice.amount,
        reportingCurrency: priceResolution.reportingPrice.currency,
        reportingRegion: config.google.priceRegion,
        purchaseToken: verified.purchaseToken,
        providerSubscriptionId: verified.providerSubscriptionId,
        basePlanId: verified.basePlanId,
        regionCode: verified.regionCode || priceResolution.customerPrice?.region || config.google.priceRegion,
        subscriptionState: verified.subscriptionState,
        autoRenewing: verified.autoRenewing,
        latestOrderId: verified.latestOrderId,
        startDate: verified.startDate?.toISOString(),
        expiryDate: verified.expiryDate.toISOString()
      }
    });
  }

  await syncUserSubscriptionStatus(userId);

  return {
    subscription,
    normalized: {
      userId,
      platform: 'google',
      productId: verified.productId,
      basePlanId: verified.basePlanId,
      purchaseToken: verified.purchaseToken,
      expiryDate: verified.expiryDate,
      status: subscription.status,
      isActive: subscription.isActive
    }
  };
};

export const verifyAppleSubscription = async ({
  userId,
  transactionId,
  receipt
}: {
  userId: string;
  transactionId?: string;
  receipt?: string;
}): Promise<NormalizedSubscriptionResult> => {
  if (!transactionId && !receipt) {
    throw createHttpError('Either Apple transactionId or receipt is required', 400);
  }

  const verified = transactionId ? await verifyAppleTransaction(transactionId) : await verifyAppleReceipt(receipt!);
  return normalizeAppleSubscription(userId, verified);
};

export const verifyGoogleSubscription = async ({
  userId,
  purchaseToken
}: {
  userId: string;
  purchaseToken: string;
}): Promise<NormalizedSubscriptionResult> => {
  const verified = await verifyGooglePurchase(purchaseToken);
  return normalizeGoogleSubscription(userId, verified);
};

export const processAppleWebhook = async (
  payload: Record<string, unknown>
): Promise<{ notificationType?: string; subtype?: string; received: true }> => {
  const parsed = parseAppleWebhookPayload(payload);
  const verified = parsed.transaction;

  if (!verified) {
    throw createHttpError('Apple webhook did not contain transaction details', 400);
  }

  const existingSubscription = await SubscriptionModel.findOne({
    platform: 'apple',
    $or: [
      { transactionId: verified.transactionId },
      ...(verified.originalTransactionId ? [{ providerSubscriptionId: verified.originalTransactionId }] : [])
    ]
  });

  if (!existingSubscription) {
    throw createHttpError('Apple webhook subscription not found for transaction', 404);
  }

  await normalizeAppleSubscription(existingSubscription.user.toString(), verified);

  return {
    notificationType: parsed.notificationType,
    subtype: parsed.subtype,
    received: true
  };
};

export const processGoogleWebhook = async (
  payload: Record<string, unknown>
): Promise<{ notificationType?: number; received: true }> => {
  const parsed = parseGoogleWebhookPayload(payload);

  if (parsed.packageName && parsed.packageName !== config.google.packageName) {
    throw createHttpError('Google webhook package name mismatch', 400);
  }
  if (!parsed.purchaseToken) {
    throw createHttpError('Google webhook did not contain a purchase token', 400);
  }

  const existingSubscription = await SubscriptionModel.findOne({
    platform: 'google',
    purchaseToken: parsed.purchaseToken
  });
  if (!existingSubscription) {
    throw createHttpError('Google webhook subscription not found for purchase token', 404);
  }

  const verified = await verifyGooglePurchase(parsed.purchaseToken);
  await normalizeGoogleSubscription(existingSubscription.user.toString(), verified);

  return {
    notificationType: parsed.notificationType,
    received: true
  };
};

export const listSubscriptions = async ({ page = 1, limit = 20 }: ListParams): Promise<PaginatedResult<SubscriptionDocument>> => {
  const pageNumber = Number(page) || 1;
  const limitNumber = Number(limit) || 20;
  const skip = (pageNumber - 1) * limitNumber;
  const [data, total] = await Promise.all([
    SubscriptionModel.find().populate('user', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limitNumber),
    SubscriptionModel.countDocuments()
  ]);
  return {
    data,
    pagination: {
      total,
      page: pageNumber,
      limit: limitNumber,
      pages: Math.ceil(total / limitNumber) || 1
    }
  };
};

export const getSubscriptionById = (id: string): Promise<SubscriptionDocument | null> => {
  return SubscriptionModel.findById(id).populate('user', 'name email');
};

export const getUserSubscriptionStatus = async (
  userId: string
): Promise<{
  subscribed: boolean;
  subscriptionStatus: 'free' | 'premium';
  activeSubscription: SubscriptionDocument | null;
}> => {
  const user = await UserModel.findById(userId).select('subscriptionStatus');
  if (!user) {
    const error = new Error('User not found');
    (error as any).statusCode = 404;
    throw error;
  }

  const activeSubscription = await getUserActiveSubscription(userId);

  if (user.subscriptionStatus !== 'premium' && activeSubscription) {
    user.subscriptionStatus = 'premium';
    await user.save();
  } else if (user.subscriptionStatus !== 'free' && !activeSubscription) {
    user.subscriptionStatus = 'free';
    await user.save();
  }

  return {
    subscribed: Boolean(activeSubscription),
    subscriptionStatus: activeSubscription ? 'premium' : 'free',
    activeSubscription
  };
};

export const getUserActiveSubscription = async (userId: string): Promise<SubscriptionDocument | null> => {
  await expireLapsedSubscriptions();
  return SubscriptionModel.findOne({
    user: userId,
    status: SUBSCRIPTION_STATUS.ACTIVE,
    isActive: true,
    expiryDate: { $gt: new Date() }
  }).sort({ expiryDate: -1 });
};

export const expireSubscription = (id: string): Promise<SubscriptionDocument | null> => {
  return SubscriptionModel.findByIdAndUpdate(id, { status: SUBSCRIPTION_STATUS.EXPIRED }, { new: true });
};

export const updateSubscriptionStatus = async ({
  subscriptionId,
  status
}: {
  subscriptionId: string;
  status: ManualSubscriptionStatus;
}): Promise<SubscriptionDocument> => {
  const subscription = await SubscriptionModel.findById(subscriptionId);
  if (!subscription) {
    const error = new Error('Subscription not found');
    (error as any).statusCode = 404;
    throw error;
  }

  if (status === 'paid') {
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.expiryDate = calculateExpiryByPlan(subscription.planType);
    subscription.isActive = true;
  } else {
    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    subscription.expiryDate = new Date();
    subscription.isActive = false;
  }

  await subscription.save();
  await syncUserSubscriptionStatus(subscription.user.toString());
  await subscription.populate('user', 'name email');

  return subscription;
};

export const updateUserSubscriptionStatus = async ({
  userId,
  status,
  planType
}: {
  userId: string;
  status: ManualSubscriptionStatus;
  planType?: PlanType;
}): Promise<SubscriptionDocument> => {
  const targetPlanType = planType && Object.values(PLAN_TYPES).includes(planType) ? planType : PLAN_TYPES.MONTHLY;
  let subscription = await SubscriptionModel.findOne({ user: userId }).sort({ createdAt: -1 });

  if (!subscription) {
    const pricing = await getPricingContext();
    const planPriceCents = getPlanPriceCents(targetPlanType, pricing);
    subscription = await SubscriptionModel.create({
      user: userId,
      planType: targetPlanType,
      price: centsToAmount(planPriceCents),
      expiryDate: calculateExpiryByPlan(targetPlanType),
      status: status === 'paid' ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.EXPIRED,
      isActive: status === 'paid'
    });
  } else if (status === 'paid') {
    subscription.status = SUBSCRIPTION_STATUS.ACTIVE;
    subscription.expiryDate = calculateExpiryByPlan(subscription.planType);
    subscription.isActive = true;
  } else {
    subscription.status = SUBSCRIPTION_STATUS.EXPIRED;
    subscription.expiryDate = new Date();
    subscription.isActive = false;
  }

  await subscription.save();
  await syncUserSubscriptionStatus(userId);
  await subscription.populate('user', 'name email');

  return subscription;
};
