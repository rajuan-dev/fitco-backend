import mongoose from 'mongoose';
import connectDatabase from '../config/database';
import config from '../config';
import TransactionModel from '../modules/subscription/transaction.model';
import { convertAmountToSar, normalizeCurrencyCode, REPORTING_CURRENCY } from '../utils/currency';

const resolveBaseCurrency = (transaction: any): string | null => {
  const meta = (transaction?.meta || {}) as Record<string, unknown>;

  return (
    normalizeCurrencyCode(typeof meta.originalCurrency === 'string' ? meta.originalCurrency : null) ||
    normalizeCurrencyCode(typeof transaction?.currency === 'string' ? transaction.currency : null) ||
    (transaction?.platform === 'stripe' ? normalizeCurrencyCode(config.stripe.currency) : null)
  );
};

const resolveBaseAmount = (transaction: any): number | null => {
  const meta = (transaction?.meta || {}) as Record<string, unknown>;

  if (typeof meta.originalAmount === 'number' && Number.isFinite(meta.originalAmount)) {
    return meta.originalAmount;
  }

  return typeof transaction?.amount === 'number' && Number.isFinite(transaction.amount) ? transaction.amount : null;
};

const run = async (): Promise<void> => {
  await connectDatabase();

  const transactions = await TransactionModel.find({ status: 'paid' });
  let updated = 0;
  let skipped = 0;

  for (const transaction of transactions) {
    const meta = (transaction.meta || {}) as Record<string, unknown>;
    const baseAmount = resolveBaseAmount(transaction);
    const baseCurrency = resolveBaseCurrency(transaction);

    if (baseAmount === null || !baseCurrency) {
      skipped += 1;
      continue;
    }

    let reportingAmount: number | null = null;
    let reportingCurrency: string | null = null;

    try {
      reportingAmount = await convertAmountToSar({
        amount: baseAmount,
        fromCurrency: baseCurrency
      });
      reportingCurrency = REPORTING_CURRENCY;
    } catch {
      if (baseCurrency === REPORTING_CURRENCY) {
        reportingAmount = baseAmount;
        reportingCurrency = REPORTING_CURRENCY;
      }
    }

    transaction.meta = {
      ...meta,
      originalAmount: baseAmount,
      originalCurrency: baseCurrency,
      ...(reportingAmount !== null ? { reportingAmount } : {}),
      ...(reportingCurrency ? { reportingCurrency } : {})
    };

    await transaction.save();
    updated += 1;
  }

  console.log(`Transaction SAR backfill complete. Updated: ${updated}, Skipped: ${skipped}`);
  await mongoose.disconnect();
};

run().catch(async error => {
  console.error('Failed to backfill SAR transaction reporting metadata', error);
  await mongoose.disconnect();
  process.exit(1);
});
