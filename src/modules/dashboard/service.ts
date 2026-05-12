import UserModel from '../user/model';
import SubscriptionModel from '../subscription/model';
import TransactionModel from '../subscription/transaction.model';
import { SUBSCRIPTION_STATUS } from '../../utils/constants';
import { convertAmountToSar, normalizeCurrencyCode, REPORTING_CURRENCY } from '../../utils/currency';
import config from '../../config';

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

interface YearFilter {
  year?: number | string;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const roundCurrency = (value: number): number => Number(value.toFixed(2));

const extractMetaNumber = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const extractMetaCurrency = (value: unknown): string | null => {
  return typeof value === 'string' ? normalizeCurrencyCode(value) : null;
};

const resolveFallbackTransactionCurrency = (transaction: Record<string, any>): string | null => {
  const inferred =
    extractMetaCurrency(transaction?.meta?.originalCurrency) ||
    extractMetaCurrency(transaction?.meta?.reportingCurrency) ||
    extractMetaCurrency(transaction?.currency) ||
    (transaction?.platform === 'stripe' ? normalizeCurrencyCode(config.stripe.currency) : null);

  return inferred;
};

const resolveTransactionReporting = async (transaction: Record<string, any>): Promise<{
  reportingAmount: number | null;
  reportingCurrency: typeof REPORTING_CURRENCY;
  originalAmount: number | null;
  originalCurrency: string | null;
}> => {
  const originalAmount = extractMetaNumber(transaction?.meta?.originalAmount);
  const originalCurrency = extractMetaCurrency(transaction?.meta?.originalCurrency);
  const storedReportingAmount = extractMetaNumber(transaction?.meta?.reportingAmount);
  const storedReportingCurrency = extractMetaCurrency(transaction?.meta?.reportingCurrency);
  const baseAmount = typeof transaction?.amount === 'number' && Number.isFinite(transaction.amount) ? transaction.amount : null;
  const baseCurrency = resolveFallbackTransactionCurrency(transaction);

  const candidates = [
    { amount: originalAmount, currency: originalCurrency },
    { amount: storedReportingAmount, currency: storedReportingCurrency },
    { amount: baseAmount, currency: baseCurrency }
  ];

  for (const candidate of candidates) {
    if (candidate.amount === null || !candidate.currency) continue;
    if (candidate.currency === REPORTING_CURRENCY) {
      return {
        reportingAmount: roundCurrency(candidate.amount),
        reportingCurrency: REPORTING_CURRENCY,
        originalAmount,
        originalCurrency
      };
    }

    try {
      return {
        reportingAmount: await convertAmountToSar({
          amount: candidate.amount,
          fromCurrency: candidate.currency
        }),
        reportingCurrency: REPORTING_CURRENCY,
        originalAmount,
        originalCurrency
      };
    } catch {
      continue;
    }
  }

  return {
    reportingAmount: null,
    reportingCurrency: REPORTING_CURRENCY,
    originalAmount,
    originalCurrency
  };
};

const sumReportingAmounts = (transactions: Array<{ reportingAmount: number | null }>): number =>
  roundCurrency(transactions.reduce((sum, item) => sum + (item.reportingAmount || 0), 0));

const enrichTransactionForReporting = async (transaction: Record<string, any>) => {
  const reporting = await resolveTransactionReporting(transaction);
  return {
    ...transaction,
    meta: {
      ...(transaction.meta || {}),
      ...(reporting.originalAmount !== null ? { originalAmount: reporting.originalAmount } : {}),
      ...(reporting.originalCurrency ? { originalCurrency: reporting.originalCurrency } : {}),
      ...(reporting.reportingAmount !== null ? { reportingAmount: reporting.reportingAmount } : {}),
      reportingCurrency: reporting.reportingCurrency
    }
  };
};

const parseYear = (year?: number | string): number => {
  const parsed = Number(year);
  const currentYear = new Date().getFullYear();
  if (!parsed || parsed < 1970 || parsed > 3000) {
    return currentYear;
  }
  return parsed;
};

export const getOverview = async () => {
  const [totalUsers, activeSubscriptions, paidTransactions] = await Promise.all([
    UserModel.countDocuments(),
    SubscriptionModel.countDocuments({ status: SUBSCRIPTION_STATUS.ACTIVE, expiryDate: { $gt: new Date() } }),
    TransactionModel.find({ status: 'paid' }).select('amount currency meta createdAt').lean()
  ]);

  const normalizedTransactions = await Promise.all(
    paidTransactions.map(async transaction => ({
      createdAt: transaction.createdAt,
      ...(await resolveTransactionReporting(transaction))
    }))
  );

  const monthlyRevenueMap = new Map<string, number>();
  const now = new Date();
  let today = 0;
  let thisMonth = 0;
  for (const transaction of normalizedTransactions) {
    if (transaction.reportingAmount === null || !transaction.createdAt) continue;
    const createdAt = new Date(transaction.createdAt);
    if (Number.isNaN(createdAt.getTime())) continue;
    const key = `${createdAt.getFullYear()}-${createdAt.getMonth() + 1}`;
    monthlyRevenueMap.set(key, roundCurrency((monthlyRevenueMap.get(key) || 0) + transaction.reportingAmount));

    if (createdAt.toDateString() === now.toDateString()) {
      today = roundCurrency(today + transaction.reportingAmount);
    }
    if (createdAt.getFullYear() === now.getFullYear() && createdAt.getMonth() === now.getMonth()) {
      thisMonth = roundCurrency(thisMonth + transaction.reportingAmount);
    }
  }

  const monthlyRevenue = [...monthlyRevenueMap.entries()]
    .map(([key, total]) => {
      const [year, month] = key.split('-').map(Number);
      return { year, month, total: roundCurrency(total) };
    })
    .sort((left, right) => (left.year === right.year ? left.month - right.month : left.year - right.year));

  return {
    totalUsers,
    activeSubscriptions,
    today,
    thisMonth,
    totalRevenue: sumReportingAmounts(normalizedTransactions),
    baseCurrency: REPORTING_CURRENCY,
    monthlyRevenue
  };
};

export const getTotals = async () => {
  const [totalUsers, paidTransactions] = await Promise.all([
    UserModel.countDocuments(),
    TransactionModel.find({ status: 'paid' }).select('amount currency meta').lean()
  ]);

  const normalizedTransactions = await Promise.all(paidTransactions.map(resolveTransactionReporting));

  return {
    totalUsers,
    totalRevenue: sumReportingAmounts(normalizedTransactions),
    baseCurrency: REPORTING_CURRENCY
  };
};

export const getUserRatioByYear = async ({ year }: YearFilter) => {
  const selectedYear = parseYear(year);
  const start = new Date(selectedYear, 0, 1);
  const end = new Date(selectedYear + 1, 0, 1);

  const monthlyAgg = await UserModel.aggregate([
    { $match: { createdAt: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { month: { $month: '$createdAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { '_id.month': 1 } }
  ]);

  const countByMonth = new Map<number, number>();
  monthlyAgg.forEach((item) => {
    countByMonth.set(item._id.month, item.count);
  });

  const monthly = MONTH_LABELS.map((label, index) => ({
    month: index + 1,
    label,
    users: countByMonth.get(index + 1) || 0
  }));

  return {
    year: selectedYear,
    monthly,
    totalUsersInYear: monthly.reduce((sum, item) => sum + item.users, 0)
  };
};

export const listRecentUsers = async ({ page = 1, limit = 20, year }: ListParams & YearFilter): Promise<PaginatedResult<any>> => {
  const pageNumber = Number(page) || 1;
  const limitNumber = Number(limit) || 20;
  const skip = (pageNumber - 1) * limitNumber;

  const query: Record<string, any> = {};
  if (year !== undefined) {
    const selectedYear = parseYear(year);
    query.createdAt = {
      $gte: new Date(selectedYear, 0, 1),
      $lt: new Date(selectedYear + 1, 0, 1)
    };
  }

  const [data, total] = await Promise.all([
    UserModel.find(query)
      .select('name firstName lastName email isBlocked createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNumber),
    UserModel.countDocuments(query)
  ]);

  const rows = data.map((user, index) => ({
    id: user._id.toString(),
    serial: skip + index + 1,
    fullName: user.name || [user.firstName, user.lastName].filter(Boolean).join(' ').trim(),
    email: user.email,
    joinedDate: user.createdAt,
    isBlocked: Boolean(user.isBlocked),
    actions: {
      block: `/api/v1/users/${user._id.toString()}/block`,
      unblock: `/api/v1/users/${user._id.toString()}/unblock`
    }
  }));

  return {
    data: rows,
    pagination: {
      total,
      page: pageNumber,
      limit: limitNumber,
      pages: Math.ceil(total / limitNumber) || 1
    }
  };
};

export const listTransactions = async ({ page = 1, limit = 20 }: ListParams): Promise<PaginatedResult<any>> => {
  const pageNumber = Number(page) || 1;
  const limitNumber = Number(limit) || 20;
  const skip = (pageNumber - 1) * limitNumber;
  const [data, total] = await Promise.all([
    TransactionModel.find().populate('user', 'name email').sort({ createdAt: -1 }).skip(skip).limit(limitNumber).lean(),
    TransactionModel.countDocuments()
  ]);
  const normalizedData = await Promise.all(data.map(enrichTransactionForReporting));
  return {
    data: normalizedData,
    pagination: {
      total,
      page: pageNumber,
      limit: limitNumber,
      pages: Math.ceil(total / limitNumber) || 1
    }
  };
};

export const getRevenueStats = async () => {
  const paidTransactions = await TransactionModel.find({ status: 'paid' }).select('planType amount currency meta').lean();
  const normalizedTransactions = await Promise.all(
    paidTransactions.map(async transaction => ({
      planType: transaction.planType,
      ...(await resolveTransactionReporting(transaction))
    }))
  );

  const statsByPlan = new Map<string, { total: number; count: number }>();
  for (const transaction of normalizedTransactions) {
    const key = String(transaction.planType || 'unknown');
    const current = statsByPlan.get(key) || { total: 0, count: 0 };
    statsByPlan.set(key, {
      total: roundCurrency(current.total + (transaction.reportingAmount || 0)),
      count: current.count + 1
    });
  }

  return [...statsByPlan.entries()].map(([planType, value]) => ({
    _id: planType,
    total: value.total,
    count: value.count,
    baseCurrency: REPORTING_CURRENCY
  }));
};
