import crypto from 'crypto';
import { JwtPayload } from 'jsonwebtoken';
import config from '../../config';
import UserModel, { UserDocument } from '../user/model';
import AdminModel, { AdminDocument } from '../admin/model';
import AuthTokenModel from './model';
import * as adminService from '../admin/service';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken, TokenPayload } from '../../utils/token';
import { ROLES, Role } from '../../utils/constants';
import { sendPasswordResetEmail, sendRegistrationOtpEmail } from '../../utils/mailer';
import { createHttpError } from '../../utils/httpError';
import { getUserActiveSubscription } from '../subscription/service';
import { getCouponByCode } from '../coupon/service';

interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  subscriptionStatus: 'active' | 'inactive';
  subscriptionExpiry: string | null;
  isSubscribed: boolean;
}

interface UserAuthResponse {
  user: AuthUser;
  token: string;
  refreshToken: string;
}

interface SanitizedAccount {
  id: string;
  email: string;
  role: Role;
  name?: string;
  firstName?: string;
  lastName?: string;
}

interface AdminAuthResponse {
  user: SanitizedAccount;
  accessToken: string;
  refreshToken: string;
}

type AccountDocument = UserDocument | AdminDocument;

interface RegisterPayload {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  referralCode?: string;
  age: number;
  height: number;
  weight: number;
  gender: 'male' | 'female';
  activityLevel: 'sedentary' | 'lightly_active' | 'moderately_active' | 'very_active' | 'extremely_active';
  goal: 'lose_weight' | 'maintain_weight' | 'gain_weight' | 'build_muscle';
  targetWeight?: number | null;
  weeklyPace?: number | null;
  medicalConditions?: string;
  allergies?: string;
}

interface RegisterResponse {
  message: string;
  email: string;
  referralCode?: string;
  referralCodeStatus: 'valid' | 'invalid' | 'not_provided';
}

interface GoogleTokenInfo {
  aud?: string;
  email?: string;
  email_verified?: string | boolean;
  exp?: string;
  family_name?: string;
  given_name?: string;
  iss?: string;
  name?: string;
}

interface AppleJwtPayload {
  aud?: string;
  email?: string;
  exp?: number;
  iss?: string;
  nonce_supported?: boolean;
  sub?: string;
}

const OTP_EXPIRY_MS = 10 * 60 * 1000;

const sanitizeAccount = (account: AccountDocument): SanitizedAccount => ({
  id: account._id.toString(),
  email: account.email,
  role: account.role as Role,
  name: account.name,
  firstName: (account as UserDocument).firstName,
  lastName: (account as UserDocument).lastName
});

const buildTokensPayload = (account: AccountDocument): TokenPayload => ({
  sub: account._id.toString(),
  role: account.role as Role
});

const persistRefreshToken = async (account: AccountDocument, token: string, decoded: JwtPayload): Promise<void> => {
  const expiresAt = new Date((decoded.exp || 0) * 1000);
  const filtered = (account.refreshTokens || []).filter((item: any) => item.expiresAt > new Date());
  filtered.push({ token, expiresAt } as any);
  account.refreshTokens = filtered;
  await account.save();
};

const hashOtp = (code: string): string => crypto.createHash('sha256').update(code).digest('hex');
const generateOtp = (): string => crypto.randomInt(0, 10000).toString().padStart(4, '0');
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const buildDisplayName = (user: Pick<UserDocument, 'name' | 'firstName' | 'lastName'>): string =>
  user.name || [user.firstName, user.lastName].filter(Boolean).join(' ').trim();

const splitDisplayName = (value: string): { firstName: string; lastName: string } => {
  const trimmed = value.trim();
  if (!trimmed) {
    return { firstName: 'Fitco', lastName: 'User' };
  }

  const parts = trimmed.split(/\s+/);
  return {
    firstName: parts[0] || 'Fitco',
    lastName: parts.slice(1).join(' ') || 'User'
  };
};

const sanitizeUserForAuth = async (user: UserDocument): Promise<AuthUser> => {
  const activeSubscription = await getUserActiveSubscription(user._id.toString());
  const isSubscribed = Boolean(activeSubscription);

  return {
    uid: user._id.toString(),
    email: user.email,
    displayName: buildDisplayName(user),
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    subscriptionStatus: isSubscribed ? 'active' : 'inactive',
    subscriptionExpiry: activeSubscription?.expiryDate ? activeSubscription.expiryDate.toISOString() : null,
    isSubscribed
  };
};

const createOtpRecord = async ({
  userId,
  type
}: {
  userId: string;
  type: 'password_reset' | 'email_verification';
}): Promise<string> => {
  const otp = generateOtp();
  await AuthTokenModel.deleteMany({ user: userId, type, used: false });
  await AuthTokenModel.create({
    user: userId,
    token: hashOtp(otp),
    type,
    expiresAt: new Date(Date.now() + OTP_EXPIRY_MS)
  });
  return otp;
};

const createInvalidOtpError = () =>
  createHttpError('The verification code you entered is invalid or has expired.', 400, {
    code: 'AUTH_INVALID_OTP'
  });

const createBase64UrlBuffer = (value: string): Buffer => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${padding}`, 'base64');
};

const parseJwtJson = <T>(segment: string): T => JSON.parse(createBase64UrlBuffer(segment).toString('utf8')) as T;

const verifyAppleIdentityToken = async (identityToken: string): Promise<AppleJwtPayload> => {
  const [encodedHeader, encodedPayload, encodedSignature] = identityToken.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw createHttpError('Invalid Apple identity token', 400, { code: 'AUTH_APPLE_INVALID_TOKEN' });
  }

  const header = parseJwtJson<{ alg?: string; kid?: string }>(encodedHeader);
  const payload = parseJwtJson<AppleJwtPayload>(encodedPayload);

  if (header.alg !== 'RS256' || !header.kid) {
    throw createHttpError('Invalid Apple identity token', 400, { code: 'AUTH_APPLE_INVALID_TOKEN' });
  }

  const keysResponse = await fetch('https://appleid.apple.com/auth/keys');
  if (!keysResponse.ok) {
    throw createHttpError('Failed to verify Apple identity token', 502, { code: 'AUTH_APPLE_VERIFY_FAILED' });
  }

  const keySet = (await keysResponse.json()) as {
    keys?: Array<Record<string, string>>;
  };
  const key = keySet.keys?.find(item => item.kid === header.kid);
  if (!key) {
    throw createHttpError('Unable to verify Apple identity token', 400, { code: 'AUTH_APPLE_KEY_NOT_FOUND' });
  }

  const publicKey = crypto.createPublicKey({
    key: key as any,
    format: 'jwk'
  });
  const verified = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    publicKey,
    createBase64UrlBuffer(encodedSignature)
  );

  if (!verified) {
    throw createHttpError('Invalid Apple identity token', 400, { code: 'AUTH_APPLE_INVALID_TOKEN' });
  }

  const now = Math.floor(Date.now() / 1000);
  if ((payload.exp || 0) <= now) {
    throw createHttpError('Apple identity token expired', 401, { code: 'AUTH_APPLE_TOKEN_EXPIRED' });
  }
  if (payload.iss !== 'https://appleid.apple.com') {
    throw createHttpError('Invalid Apple identity token issuer', 400, { code: 'AUTH_APPLE_INVALID_ISSUER' });
  }
  if (config.apple.bundleId && payload.aud !== config.apple.bundleId) {
    throw createHttpError('Apple identity token audience mismatch', 400, { code: 'AUTH_APPLE_AUDIENCE_MISMATCH' });
  }

  return payload;
};

const verifyGoogleIdToken = async (idToken: string): Promise<GoogleTokenInfo> => {
  const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!response.ok) {
    throw createHttpError('Invalid Google ID token', 400, { code: 'AUTH_GOOGLE_INVALID_TOKEN' });
  }

  const payload = (await response.json()) as GoogleTokenInfo;
  const issuers = new Set(['accounts.google.com', 'https://accounts.google.com']);
  if (!payload.iss || !issuers.has(payload.iss)) {
    throw createHttpError('Invalid Google token issuer', 400, { code: 'AUTH_GOOGLE_INVALID_ISSUER' });
  }
  if (config.google.oauthClientIds.length > 0 && (!payload.aud || !config.google.oauthClientIds.includes(payload.aud))) {
    throw createHttpError('Google token audience mismatch', 400, { code: 'AUTH_GOOGLE_AUDIENCE_MISMATCH' });
  }

  return payload;
};

const resolveOrCreateOauthUser = async ({
  email,
  firstName,
  lastName
}: {
  email: string;
  firstName?: string;
  lastName?: string;
}): Promise<UserDocument> => {
  const normalizedEmail = normalizeEmail(email);
  const existing = await UserModel.findOne({ email: normalizedEmail });
  const fallbackName = splitDisplayName([firstName, lastName].filter(Boolean).join(' '));
  const resolvedFirstName = firstName?.trim() || existing?.firstName || fallbackName.firstName;
  const resolvedLastName = lastName?.trim() || existing?.lastName || fallbackName.lastName;

  if (existing) {
    existing.firstName = resolvedFirstName;
    existing.lastName = resolvedLastName;
    existing.name = `${resolvedFirstName} ${resolvedLastName}`.trim();
    existing.emailVerified = true;
    await existing.save();
    return existing;
  }

  return UserModel.create({
    email: normalizedEmail,
    password: crypto.randomBytes(24).toString('hex'),
    firstName: resolvedFirstName,
    lastName: resolvedLastName,
    name: `${resolvedFirstName} ${resolvedLastName}`.trim(),
    emailVerified: true,
    role: ROLES.USER
  });
};

const buildUserAuthResponse = async (user: UserDocument): Promise<UserAuthResponse> => {
  const token = generateAccessToken(buildTokensPayload(user));
  const refreshToken = generateRefreshToken(buildTokensPayload(user));
  const decoded = verifyRefreshToken(refreshToken);
  await persistRefreshToken(user, refreshToken, decoded);

  return {
    user: await sanitizeUserForAuth(user),
    token,
    refreshToken
  };
};

export const registerUser = async (payload: RegisterPayload): Promise<RegisterResponse> => {
  const email = normalizeEmail(payload.email);
  const firstName = payload.firstName.trim();
  const lastName = payload.lastName.trim();
  const normalizedReferralCode = payload.referralCode?.trim().toUpperCase() || undefined;
  const existing = await UserModel.findOne({ email });

  if (existing?.emailVerified) {
    throw createHttpError('Email already registered', 400, { code: 'AUTH_EMAIL_EXISTS' });
  }

  const user =
    existing ||
    new UserModel({
      email,
      role: ROLES.USER
    });

  user.firstName = firstName;
  user.lastName = lastName;
  user.name = `${firstName} ${lastName}`.trim();
  user.email = email;
  user.password = payload.password;
  user.emailVerified = false;
  user.referralCode = normalizedReferralCode;
  user.age = payload.age;
  user.height = payload.height;
  user.currentWeight = payload.weight;
  user.weight = payload.weight;
  user.targetWeight = payload.targetWeight ?? undefined;
  user.weeklyPace = payload.weeklyPace ?? undefined;
  user.gender = payload.gender;
  user.activityLevel = payload.activityLevel;
  user.goal = payload.goal;
  user.goals = payload.goal;
  user.medicalConditions = payload.medicalConditions?.trim() || '';
  user.foodAllergies = payload.allergies?.trim() || '';
  user.refreshTokens = [];
  await user.save();

  const referralCodeStatus = normalizedReferralCode
    ? ((await getCouponByCode(normalizedReferralCode)) ? 'valid' : 'invalid')
    : 'not_provided';

  const otp = await createOtpRecord({ userId: user._id.toString(), type: 'email_verification' });
  await sendRegistrationOtpEmail({ email: user.email, otp });

  return {
    message: 'Registration successful. Please verify the OTP sent to your email.',
    email: user.email,
    ...(normalizedReferralCode ? { referralCode: normalizedReferralCode } : {}),
    referralCodeStatus
  };
};

export const verifyRegisterOtp = async (emailInput: string, code: string): Promise<UserAuthResponse> => {
  const user = await UserModel.findOne({ email: normalizeEmail(emailInput) });
  if (!user) {
    throw createInvalidOtpError();
  }

  const record = await AuthTokenModel.findOne({
    user: user._id,
    token: hashOtp(code),
    type: 'email_verification',
    used: false
  });

  if (!record || record.expiresAt < new Date()) {
    throw createInvalidOtpError();
  }

  user.emailVerified = true;
  await user.save();
  record.used = true;
  record.verified = true;
  await record.save();

  return buildUserAuthResponse(user);
};

export const loginUser = async ({ email, password }: { email: string; password: string }): Promise<UserAuthResponse | null> => {
  const user = await UserModel.findOne({ email: normalizeEmail(email) });
  if (!user) {
    return null;
  }
  if (!user.emailVerified) {
    throw createHttpError('Please verify your email before logging in.', 400, {
      code: 'AUTH_EMAIL_NOT_VERIFIED'
    });
  }
  const matches = await user.comparePassword(password);
  if (!matches) {
    return null;
  }
  if (user.isBlocked) {
    throw createHttpError('Account is blocked', 403, { code: 'AUTH_ACCOUNT_BLOCKED' });
  }
  return buildUserAuthResponse(user);
};

export const loginWithGoogle = async ({
  idToken,
  email
}: {
  idToken: string;
  email?: string;
}): Promise<UserAuthResponse> => {
  const payload = await verifyGoogleIdToken(idToken);
  if (!payload.email) {
    throw createHttpError('Google account email is missing from token', 400, { code: 'AUTH_GOOGLE_EMAIL_MISSING' });
  }
  if (String(payload.email_verified) !== 'true' && payload.email_verified !== true) {
    throw createHttpError('Google email address is not verified', 400, { code: 'AUTH_GOOGLE_EMAIL_NOT_VERIFIED' });
  }

  const normalizedPayloadEmail = normalizeEmail(payload.email);
  if (email && normalizeEmail(email) !== normalizedPayloadEmail) {
    throw createHttpError('Google token email mismatch', 400, { code: 'AUTH_GOOGLE_EMAIL_MISMATCH' });
  }

  const user = await resolveOrCreateOauthUser({
    email: normalizedPayloadEmail,
    firstName: payload.given_name,
    lastName: payload.family_name || splitDisplayName(payload.name || '').lastName
  });

  if (user.isBlocked) {
    throw createHttpError('Account is blocked', 403, { code: 'AUTH_ACCOUNT_BLOCKED' });
  }

  return buildUserAuthResponse(user);
};

export const loginWithApple = async ({
  identityToken,
  email,
  firstName,
  lastName
}: {
  identityToken: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}): Promise<UserAuthResponse> => {
  const payload = await verifyAppleIdentityToken(identityToken);
  const resolvedEmail = normalizeEmail(email || payload.email || '');
  if (!resolvedEmail) {
    throw createHttpError('Apple account email is required', 400, { code: 'AUTH_APPLE_EMAIL_MISSING' });
  }
  if (payload.email && normalizeEmail(payload.email) !== resolvedEmail) {
    throw createHttpError('Apple token email mismatch', 400, { code: 'AUTH_APPLE_EMAIL_MISMATCH' });
  }

  const user = await resolveOrCreateOauthUser({
    email: resolvedEmail,
    firstName,
    lastName
  });

  if (user.isBlocked) {
    throw createHttpError('Account is blocked', 403, { code: 'AUTH_ACCOUNT_BLOCKED' });
  }

  return buildUserAuthResponse(user);
};

export const loginAdmin = async ({ email, password }: { email: string; password: string }): Promise<AdminAuthResponse | null> => {
  const admin = await adminService.authenticate(email.toLowerCase(), password);
  if (!admin) {
    return null;
  }
  const accessToken = generateAccessToken(buildTokensPayload(admin));
  const refreshToken = generateRefreshToken(buildTokensPayload(admin));
  const decoded = verifyRefreshToken(refreshToken);
  await persistRefreshToken(admin, refreshToken, decoded);
  return { user: sanitizeAccount(admin), accessToken, refreshToken };
};

export const refreshTokens = async (token: string): Promise<AdminAuthResponse | UserAuthResponse> => {
  const payload = verifyRefreshToken(token);
  const account =
    payload.role === ROLES.ADMIN
      ? await AdminModel.findById(payload.sub)
      : await UserModel.findById(payload.sub);
  if (!account) {
    throw createHttpError('Invalid token', 401, { code: 'AUTH_INVALID_TOKEN' });
  }
  if (payload.role === ROLES.USER && (account as UserDocument).isBlocked) {
    throw createHttpError('Account is blocked', 403, { code: 'AUTH_ACCOUNT_BLOCKED' });
  }
  const stored = (account.refreshTokens || []).find((item) => item.token === token && item.expiresAt > new Date());
  if (!stored) {
    throw createHttpError('Refresh token revoked', 401, { code: 'AUTH_REFRESH_REVOKED' });
  }
  account.refreshTokens = (account.refreshTokens || []).filter((item: any) => item.token !== token);
  const newAccessToken = generateAccessToken(buildTokensPayload(account));
  const newRefreshToken = generateRefreshToken(buildTokensPayload(account));
  const decoded = verifyRefreshToken(newRefreshToken);
  await persistRefreshToken(account, newRefreshToken, decoded);

  if (payload.role === ROLES.ADMIN) {
    return {
      user: sanitizeAccount(account as AdminDocument),
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    };
  }

  return {
    user: await sanitizeUserForAuth(account as UserDocument),
    token: newAccessToken,
    refreshToken: newRefreshToken
  };
};

export const forgotPassword = async (emailInput: string): Promise<void> => {
  const user = await UserModel.findOne({ email: normalizeEmail(emailInput) });
  if (!user || !user.emailVerified) {
    return;
  }

  const otp = await createOtpRecord({ userId: user._id.toString(), type: 'password_reset' });
  await sendPasswordResetEmail({ email: user.email, otp });
};

export const verifyResetOtp = async (emailInput: string, code: string): Promise<void> => {
  const user = await UserModel.findOne({ email: normalizeEmail(emailInput) });
  if (!user) {
    throw createInvalidOtpError();
  }

  const record = await AuthTokenModel.findOne({
    user: user._id,
    token: hashOtp(code),
    type: 'password_reset',
    used: false
  });

  if (!record || record.expiresAt < new Date()) {
    throw createInvalidOtpError();
  }

  if (!record.verified) {
    record.verified = true;
    await record.save();
  }
};

export const resetPassword = async ({
  email,
  code,
  newPassword
}: {
  email: string;
  code: string;
  newPassword: string;
}): Promise<void> => {
  const user = await UserModel.findOne({ email: normalizeEmail(email) });
  if (!user) {
    throw createHttpError('User not found', 404, { code: 'AUTH_USER_NOT_FOUND' });
  }

  const record = await AuthTokenModel.findOne({
    user: user._id,
    token: hashOtp(code),
    type: 'password_reset',
    used: false,
    verified: true
  });

  if (!record || record.expiresAt < new Date()) {
    throw createHttpError('OTP not verified or expired', 400, {
      code: 'AUTH_RESET_OTP_NOT_VERIFIED'
    });
  }

  user.password = newPassword;
  user.refreshTokens = [];
  await user.save();
  record.used = true;
  await record.save();
};

export const changePassword = async (userId: string, currentPassword: string, newPassword: string): Promise<void> => {
  const user = await UserModel.findById(userId);
  if (!user) {
    throw createHttpError('User not found', 404, { code: 'AUTH_USER_NOT_FOUND' });
  }
  const matches = await user.comparePassword(currentPassword);
  if (!matches) {
    throw createHttpError('Invalid current password', 400, {
      code: 'AUTH_INVALID_CURRENT_PASSWORD'
    });
  }
  user.password = newPassword;
  user.refreshTokens = [];
  await user.save();
};

export const deleteAccount = async (userId: string): Promise<void> => {
  await UserModel.findByIdAndDelete(userId);
};
