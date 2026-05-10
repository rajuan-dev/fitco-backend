import dotenv from 'dotenv';

dotenv.config();

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  accessExpiresIn: string;
  refreshExpiresIn: string;
}

export interface AppConfig {
  env: string;
  port: number;
  mongoUri: string;
  dnsServers: string[];
  jwt: JwtConfig;
  chat: {
    freeLimit: number;
    paidMonthlyLimit: number;
  };
  stripe: {
    secretKey: string;
    webhookSecret: string;
    currency: string;
    monthlyPriceCents: number;
    yearlyPriceCents: number;
    successUrl: string;
    cancelUrl: string;
  };
  apple: {
    issuerId: string;
    keyId: string;
    bundleId: string;
    privateKey: string;
    environment: 'sandbox' | 'production';
    monthlyProductIds: string[];
    yearlyProductIds: string[];
    monthlySubscriptionIds: string[];
    yearlySubscriptionIds: string[];
    priceTerritory: string;
    sharedSecret: string;
  };
  google: {
    packageName: string;
    serviceAccountEmail: string;
    serviceAccountPrivateKey: string;
    monthlyProductIds: string[];
    yearlyProductIds: string[];
    monthlyBasePlanIds: string[];
    yearlyBasePlanIds: string[];
    priceRegion: string;
  };
}

const config: AppConfig = {
  env: process.env.NODE_ENV || '',
  port: Number(process.env.PORT || 5000),
  mongoUri: process.env.MONGO_URI || '',
  dnsServers: (process.env.DNS_SERVERS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean),
  jwt: {
    accessSecret: process.env.JWT_SECRET || 'changemeaccess',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'changemerefresh',
    accessExpiresIn: '30d',
    refreshExpiresIn: '30d'
  },
  chat: {
    freeLimit: Number(process.env.FREE_CHAT_DAILY_LIMIT || 2),
    paidMonthlyLimit: Number(process.env.PAID_CHAT_MONTHLY_LIMIT || 1000)
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    currency: process.env.STRIPE_CURRENCY || 'usd',
    monthlyPriceCents: Number(process.env.STRIPE_MONTHLY_PRICE_CENTS || 999),
    yearlyPriceCents: Number(process.env.STRIPE_YEARLY_PRICE_CENTS || 9999),
    successUrl: process.env.STRIPE_SUCCESS_URL || '',
    cancelUrl: process.env.STRIPE_CANCEL_URL || ''
  },
  apple: {
    issuerId: process.env.APPLE_ISSUER_ID || '',
    keyId: process.env.APPLE_KEY_ID || '',
    bundleId: process.env.APPLE_BUNDLE_ID || '',
    privateKey: (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    environment: process.env.APPLE_ENVIRONMENT === 'production' ? 'production' : 'sandbox',
    monthlyProductIds: (process.env.APPLE_MONTHLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    yearlyProductIds: (process.env.APPLE_YEARLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    monthlySubscriptionIds: (process.env.APPLE_MONTHLY_SUBSCRIPTION_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    yearlySubscriptionIds: (process.env.APPLE_YEARLY_SUBSCRIPTION_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    priceTerritory: process.env.APPLE_PRICE_TERRITORY || 'USA',
    sharedSecret: process.env.APPLE_SHARED_SECRET || ''
  },
  google: {
    packageName: process.env.GOOGLE_PACKAGE_NAME || '',
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
    serviceAccountPrivateKey: (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    monthlyProductIds: (process.env.GOOGLE_MONTHLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    yearlyProductIds: (process.env.GOOGLE_YEARLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    monthlyBasePlanIds: (process.env.GOOGLE_MONTHLY_BASE_PLAN_IDS || process.env.GOOGLE_MONTHLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    yearlyBasePlanIds: (process.env.GOOGLE_YEARLY_BASE_PLAN_IDS || process.env.GOOGLE_YEARLY_PRODUCT_IDS || '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean),
    priceRegion: process.env.GOOGLE_PRICE_REGION || 'US'
  }
};

export default config;
