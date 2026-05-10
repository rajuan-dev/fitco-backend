const EXCHANGE_RATE_API_BASE_URL = process.env.EXCHANGE_RATE_API_BASE_URL || 'https://open.er-api.com/v6/latest';

const rateCache = new Map<string, { expiresAt: number; rates: Record<string, number> }>();

const createHttpError = (message: string, statusCode: number): Error & { statusCode: number } => {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
};

const roundCurrency = (value: number): number => Number(value.toFixed(2));

const getRatesForBase = async (baseCurrency: string): Promise<Record<string, number>> => {
  const base = baseCurrency.trim().toUpperCase();
  const now = Date.now();
  const cached = rateCache.get(base);

  if (cached && cached.expiresAt > now) {
    return cached.rates;
  }

  const response = await fetch(`${EXCHANGE_RATE_API_BASE_URL}/${encodeURIComponent(base)}`);
  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(`Exchange rate request failed: ${body || response.statusText}`, response.status);
  }

  const payload = (await response.json()) as {
    result?: string;
    rates?: Record<string, number>;
    base_code?: string;
  };

  if (payload.result === 'error' || !payload.rates || Object.keys(payload.rates).length === 0) {
    throw createHttpError('Exchange rate response is missing rates', 400);
  }

  rateCache.set(base, {
    rates: payload.rates,
    expiresAt: now + 1000 * 60 * 60
  });

  return payload.rates;
};

export const convertAmount = async ({
  amount,
  fromCurrency,
  toCurrency
}: {
  amount: number;
  fromCurrency: string;
  toCurrency: string;
}): Promise<number> => {
  const normalizedFrom = fromCurrency.trim().toUpperCase();
  const normalizedTo = toCurrency.trim().toUpperCase();

  if (!Number.isFinite(amount)) {
    throw createHttpError('Amount must be a finite number', 400);
  }

  if (normalizedFrom === normalizedTo) {
    return roundCurrency(amount);
  }

  const rates = await getRatesForBase(normalizedFrom);
  const rate = rates[normalizedTo];
  if (!rate || !Number.isFinite(rate)) {
    throw createHttpError(`Exchange rate not available for ${normalizedFrom} -> ${normalizedTo}`, 400);
  }

  return roundCurrency(amount * rate);
};

export const convertAmountToUsd = async ({
  amount,
  fromCurrency
}: {
  amount: number;
  fromCurrency: string;
}): Promise<number> => convertAmount({ amount, fromCurrency, toCurrency: 'USD' });
