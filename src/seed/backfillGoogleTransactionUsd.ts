import mongoose from 'mongoose';
import connectDatabase from '../config/database';
import config from '../config';
import SubscriptionPricingModel from '../modules/subscription/pricing.model';
import TransactionModel from '../modules/subscription/transaction.model';
import { getGoogleBasePlanPrice } from '../modules/subscription/google.service';
import { PLAN_TYPES, PlanType } from '../utils/constants';
import { convertAmountToUsd } from '../utils/currency';

const resolvePlanType = (basePlanId?: string, productId?: string): PlanType | null => {
  if (basePlanId) {
    if (config.google.monthlyBasePlanIds.includes(basePlanId)) {
      return PLAN_TYPES.MONTHLY;
    }
    if (config.google.yearlyBasePlanIds.includes(basePlanId)) {
      return PLAN_TYPES.YEARLY;
    }
  }

  if (productId) {
    if (config.google.monthlyProductIds.includes(productId)) {
      return PLAN_TYPES.MONTHLY;
    }
    if (config.google.yearlyProductIds.includes(productId)) {
      return PLAN_TYPES.YEARLY;
    }
  }

  return null;
};

const centsToAmount = (value: number): number => Number((value / 100).toFixed(2));

const getAdminReportingPrice = async (planType: PlanType): Promise<{ amount: number; currency: string }> => {
  const settings = await SubscriptionPricingModel.findOne({ key: 'default' }).lean();
  const monthlyPriceCents = settings?.monthlyPriceCents ?? Number(process.env.STRIPE_MONTHLY_PRICE_CENTS || 999);
  const yearlyPriceCents = settings?.yearlyPriceCents ?? Number(process.env.STRIPE_YEARLY_PRICE_CENTS || 9999);
  const currency = String(settings?.currency || process.env.STRIPE_CURRENCY || 'usd').toUpperCase();

  return {
    amount: centsToAmount(planType === PLAN_TYPES.YEARLY ? yearlyPriceCents : monthlyPriceCents),
    currency
  };
};

const resolveReportingPrice = async ({
  customerPrice,
  fallbackPrice
}: {
  customerPrice?: { amount: number; currency: string } | null;
  fallbackPrice: { amount: number; currency: string };
}): Promise<{ amount: number; currency: string }> => {
  const priceToConvert = customerPrice || fallbackPrice;

  try {
    return {
      amount: await convertAmountToUsd({
        amount: priceToConvert.amount,
        fromCurrency: priceToConvert.currency
      }),
      currency: 'USD'
    };
  } catch {
    if (fallbackPrice.currency.toUpperCase() === 'USD') {
      return {
        amount: fallbackPrice.amount,
        currency: 'USD'
      };
    }

    return {
      amount: priceToConvert.amount,
      currency: priceToConvert.currency.toUpperCase()
    };
  }
};

const run = async (): Promise<void> => {
  await connectDatabase();

  const transactions = await TransactionModel.find({
    platform: 'google',
    status: 'paid'
  });

  let updated = 0;
  let skipped = 0;

  for (const transaction of transactions) {
    const meta = (transaction.meta || {}) as Record<string, unknown>;
    const basePlanId = typeof meta.basePlanId === 'string' ? meta.basePlanId : undefined;
    const regionCode = typeof meta.regionCode === 'string' ? meta.regionCode : undefined;
    const productId = transaction.productId;
    const planType = resolvePlanType(basePlanId, productId);

    if (!productId || !basePlanId || !planType) {
      skipped += 1;
      continue;
    }

    const fallbackPrice =
      (await getGoogleBasePlanPrice({
        productId,
        basePlanId,
        region: config.google.priceRegion
      })) || (await getAdminReportingPrice(planType));

    let customerPrice = null;
    if (regionCode && regionCode !== config.google.priceRegion) {
      try {
        customerPrice = await getGoogleBasePlanPrice({
          productId,
          basePlanId,
          region: regionCode
        });
      } catch {
        customerPrice = null;
      }
    }

    const reportingPrice = await resolveReportingPrice({
      customerPrice,
      fallbackPrice: {
        amount: fallbackPrice.amount,
        currency: fallbackPrice.currency
      }
    });

    const existingOriginalAmount =
      typeof meta.originalAmount === 'number' ? meta.originalAmount : transaction.amount;
    const existingOriginalCurrency =
      typeof meta.originalCurrency === 'string'
        ? meta.originalCurrency
        : transaction.currency || customerPrice?.currency || reportingPrice.currency;

    const effectiveCustomerPrice =
      Number.isFinite(existingOriginalAmount) && typeof existingOriginalCurrency === 'string'
        ? {
            amount: existingOriginalAmount,
            currency: existingOriginalCurrency
          }
        : customerPrice;

    const normalizedReportingPrice = await resolveReportingPrice({
      customerPrice: effectiveCustomerPrice,
      fallbackPrice: {
        amount: fallbackPrice.amount,
        currency: fallbackPrice.currency
      }
    });

    transaction.amount = normalizedReportingPrice.amount;
    transaction.currency = normalizedReportingPrice.currency;
    transaction.planType = planType;
    transaction.meta = {
      ...meta,
      originalAmount: customerPrice?.amount ?? existingOriginalAmount,
      originalCurrency: customerPrice?.currency ?? existingOriginalCurrency,
      originalRegion: customerPrice?.region ?? regionCode ?? config.google.priceRegion,
      reportingAmount: normalizedReportingPrice.amount,
      reportingCurrency: normalizedReportingPrice.currency,
      reportingRegion: config.google.priceRegion
    };

    await transaction.save();
    updated += 1;
  }

  console.log(`Google transaction backfill complete. Updated: ${updated}, Skipped: ${skipped}`);
  await mongoose.disconnect();
};

run().catch(async error => {
  console.error('Failed to backfill Google transactions', error);
  await mongoose.disconnect();
  process.exit(1);
});
