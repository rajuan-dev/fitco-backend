import crypto from 'crypto';
import config from '../../config';

export interface GoogleVerifiedSubscription {
  productId: string;
  purchaseToken: string;
  basePlanId?: string;
  providerSubscriptionId?: string;
  expiryDate: Date;
  startDate?: Date;
  autoRenewing: boolean;
  subscriptionState: string;
  latestOrderId?: string;
  regionCode?: string;
  recurringPrice?: {
    amount: number;
    currency: string;
  };
}

export interface GoogleCatalogPrice {
  amount: number;
  currency: string;
  region: string;
}

interface GoogleLineItem {
  productId?: string;
  expiryTime?: string;
  latestSuccessfulOrderId?: string;
  autoRenewingPlan?: {
    recurringPrice?: GoogleMonetizationMoney;
    [key: string]: unknown;
  };
  offerDetails?: {
    basePlanId?: string;
  };
}

interface GoogleSubscriptionResponse {
  subscriptionState?: string;
  startTime?: string;
  latestOrderId?: string;
  regionCode?: string;
  lineItems?: GoogleLineItem[];
}

interface GoogleWebhookNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
}

const GOOGLE_OAUTH_AUDIENCE = 'https://oauth2.googleapis.com/token';
const GOOGLE_API_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const createHttpError = (message: string, statusCode: number): Error & { statusCode: number } => {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
};

const ensureGoogleConfigured = (): void => {
  if (!config.google.packageName || !config.google.serviceAccountEmail || !config.google.serviceAccountPrivateKey) {
    throw createHttpError(
      'Google subscription verification is not configured. Missing Play Developer credentials',
      400
    );
  }
};

const toBase64Url = (value: Buffer | string): string =>
  Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const fromBase64Url = (value: string): Buffer => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = 4 - (normalized.length % 4 || 4);
  return Buffer.from(normalized + '='.repeat(padding), 'base64');
};

const createGoogleAccessToken = async (): Promise<string> => {
  ensureGoogleConfigured();

  const header = { alg: 'RS256', typ: 'JWT' };
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = {
    iss: config.google.serviceAccountEmail,
    scope: GOOGLE_API_SCOPE,
    aud: GOOGLE_OAUTH_AUDIENCE,
    iat: issuedAt,
    exp: issuedAt + 3600
  };

  const encodedHeader = toBase64Url(JSON.stringify(header));
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const unsignedToken = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsignedToken), config.google.serviceAccountPrivateKey);
  const assertion = `${unsignedToken}.${toBase64Url(signature)}`;

  const response = await fetch(GOOGLE_OAUTH_AUDIENCE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    }).toString()
  });

  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(`Google access token request failed: ${body || response.statusText}`, response.status);
  }

  const data = (await response.json()) as { access_token?: string };
  if (!data.access_token) {
    throw createHttpError('Google access token response is missing access_token', 400);
  }

  return data.access_token;
};

const mapGoogleSubscription = (
  purchaseToken: string,
  payload: GoogleSubscriptionResponse
): GoogleVerifiedSubscription => {
  const lineItem = payload.lineItems?.[0];

  if (!lineItem?.productId || !lineItem.expiryTime) {
    throw createHttpError('Google subscription response is missing required fields', 400);
  }

  return {
    productId: lineItem.productId,
    purchaseToken,
    basePlanId: lineItem.offerDetails?.basePlanId,
    providerSubscriptionId: payload.latestOrderId || lineItem.latestSuccessfulOrderId,
    expiryDate: new Date(lineItem.expiryTime),
    startDate: payload.startTime ? new Date(payload.startTime) : undefined,
    autoRenewing: Boolean(lineItem.autoRenewingPlan),
    subscriptionState: payload.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED',
    latestOrderId: payload.latestOrderId || lineItem.latestSuccessfulOrderId,
    regionCode: payload.regionCode,
    recurringPrice:
      moneyToAmount(lineItem.autoRenewingPlan?.recurringPrice) !== null && lineItem.autoRenewingPlan?.recurringPrice?.currencyCode
        ? {
            amount: moneyToAmount(lineItem.autoRenewingPlan?.recurringPrice) as number,
            currency: lineItem.autoRenewingPlan.recurringPrice.currencyCode
          }
        : undefined
  };
};

export const verifyGooglePurchase = async (purchaseToken: string): Promise<GoogleVerifiedSubscription> => {
  const accessToken = await createGoogleAccessToken();
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      config.google.packageName
    )}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(`Google verification failed: ${body || response.statusText}`, response.status);
  }

  return mapGoogleSubscription(purchaseToken, (await response.json()) as GoogleSubscriptionResponse);
};

export const acknowledgeGoogleSubscription = async ({
  productId,
  purchaseToken
}: {
  productId: string;
  purchaseToken: string;
}): Promise<void> => {
  const accessToken = await createGoogleAccessToken();
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      config.google.packageName
    )}/purchases/subscriptions/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}:acknowledge`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(`Google acknowledge failed: ${body || response.statusText}`, response.status);
  }
};

interface GoogleMonetizationMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

interface GoogleRegionalBasePlanConfig {
  regionCode?: string;
  price?: GoogleMonetizationMoney;
}

interface GoogleBasePlanCatalog {
  basePlanId?: string;
  regionalConfigs?: GoogleRegionalBasePlanConfig[];
}

interface GoogleSubscriptionCatalogResponse {
  basePlans?: GoogleBasePlanCatalog[];
}

const moneyToAmount = (money?: GoogleMonetizationMoney): number | null => {
  if (!money?.currencyCode) {
    return null;
  }

  const units = Number(money.units || 0);
  const nanos = Number(money.nanos || 0) / 1_000_000_000;
  return Number((units + nanos).toFixed(2));
};

export const getGoogleBasePlanPrice = async ({
  productId,
  basePlanId,
  region
}: {
  productId: string;
  basePlanId: string;
  region: string;
}): Promise<GoogleCatalogPrice | null> => {
  const accessToken = await createGoogleAccessToken();
  const response = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(
      config.google.packageName
    )}/subscriptions/${encodeURIComponent(productId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw createHttpError(`Google catalog request failed: ${body || response.statusText}`, response.status);
  }

  const payload = (await response.json()) as GoogleSubscriptionCatalogResponse;
  const basePlan = payload.basePlans?.find(item => item.basePlanId === basePlanId);
  const regionalConfig = basePlan?.regionalConfigs?.find(item => item.regionCode === region);
  const amount = moneyToAmount(regionalConfig?.price);
  const currency = regionalConfig?.price?.currencyCode;

  if (amount === null || !currency) {
    return null;
  }

  return {
    amount,
    currency,
    region
  };
};

export const parseGoogleWebhookPayload = (
  payload: Record<string, unknown>
): {
  packageName?: string;
  purchaseToken?: string;
  productId?: string;
  notificationType?: number;
} => {
  const message = payload.message as { data?: string } | undefined;
  if (!message?.data) {
    throw createHttpError('Missing Google Pub/Sub message data', 400);
  }

  const decoded = JSON.parse(fromBase64Url(message.data).toString('utf8')) as GoogleWebhookNotification;

  return {
    packageName: decoded.packageName,
    purchaseToken: decoded.subscriptionNotification?.purchaseToken,
    productId: decoded.subscriptionNotification?.subscriptionId,
    notificationType: decoded.subscriptionNotification?.notificationType
  };
};
