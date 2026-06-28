import { Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import * as authService from './service';
import { authenticate, authorizeRoles } from '../../middlewares/authMiddleware';
import { ROLES } from '../../utils/constants';

const allowOnlyFields = (allowedFields: string[]) =>
  body().custom((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Request body must be a JSON object');
    }
    const invalidFields = Object.keys(value).filter((key) => !allowedFields.includes(key));
    if (invalidFields.length > 0) {
      throw new Error(`Only these fields are allowed: ${allowedFields.join(', ')}`);
    }
    return true;
  });

const validateAuthRequest = (req: Request, _res: Response, next: () => void): void => {
  const result = validationResult(req);
  if (result.isEmpty()) {
    next();
    return;
  }

  const errors = result.array().map((error) => ({
    field: 'path' in error ? error.path : 'request',
    message: error.msg
  }));

  _res.status(400).json({
    message: errors[0]?.message || 'Validation failed',
    errors
  });
  return;
};

const registerValidators = [
  allowOnlyFields([
    'email',
    'password',
    'referralCode',
    'firstName',
    'lastName',
    'age',
    'height',
    'weight',
    'gender',
    'activityLevel',
    'goal',
    'targetWeight',
    'weeklyPace',
    'medicalConditions',
    'allergies'
  ]),
  body('firstName').isString().trim().notEmpty(),
  body('lastName').isString().trim().notEmpty(),
  body('email').isEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.'),
  body('referralCode').optional().isString().trim().notEmpty(),
  body('age').isInt({ min: 1, max: 120 }),
  body('height').isFloat({ gt: 0, max: 300 }),
  body('weight').isFloat({ gt: 0, max: 500 }),
  body('gender').isIn(['male', 'female']),
  body('activityLevel').isIn(['sedentary', 'lightly_active', 'moderately_active', 'very_active', 'extremely_active']),
  body('goal').isIn(['lose_weight', 'maintain_weight', 'gain_weight', 'build_muscle']),
  body('targetWeight').optional({ values: 'null' }).isFloat({ gt: 0, max: 500 }),
  body('weeklyPace').optional({ values: 'null' }).isFloat({ gt: 0, max: 10 }),
  body('medicalConditions').optional().isString(),
  body('allergies').optional().isString(),
  body().custom((value) => {
    if (value.goal !== 'maintain_weight' && (value.targetWeight === undefined || value.targetWeight === null)) {
      throw new Error('targetWeight is required unless goal is maintain_weight.');
    }

    if (
      (value.goal === 'lose_weight' || value.goal === 'gain_weight') &&
      (value.weeklyPace === undefined || value.weeklyPace === null)
    ) {
      throw new Error('weeklyPace is required for lose_weight or gain_weight goals.');
    }

    return true;
  })
];

const loginValidators = [allowOnlyFields(['email', 'password']), body('email').isEmail(), body('password').notEmpty()];
const googleLoginValidators = [
  allowOnlyFields(['idToken', 'email']),
  body('idToken').isString().trim().notEmpty(),
  body('email').optional().isEmail()
];
const appleLoginValidators = [
  allowOnlyFields(['identityToken', 'email', 'firstName', 'lastName']),
  body('identityToken').isString().trim().notEmpty(),
  body('email').optional().isEmail(),
  body('firstName').optional().isString(),
  body('lastName').optional().isString()
];
const verifyRegisterValidators = [allowOnlyFields(['email', 'code']), body('email').isEmail(), body('code').isLength({ min: 4, max: 4 })];
const forgotValidators = [allowOnlyFields(['email']), body('email').isEmail()];
const verifyOtpValidators = [allowOnlyFields(['email', 'code']), body('email').isEmail(), body('code').isLength({ min: 4, max: 4 })];
const resetValidators = [
  allowOnlyFields(['email', 'code', 'password']),
  body('email').isEmail(),
  body('code').isLength({ min: 4, max: 4 }),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.')
];
const refreshValidators = [allowOnlyFields(['refreshToken']), body('refreshToken').isString().trim().notEmpty()];
const changeValidators = [
  allowOnlyFields(['currentPassword', 'newPassword']),
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters.')
];

export const register = [
  ...registerValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const response = await authService.registerUser(req.body);
    res.status(201).json(response);
  })
];

export const verifyRegister = [
  ...verifyRegisterValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authService.verifyRegisterOtp(req.body.email, req.body.code);
    res.json(auth);
  })
];

export const login = [
  ...loginValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authService.loginUser(req.body);
    if (!auth) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    res.json(auth);
  })
];

export const googleLogin = [
  ...googleLoginValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authService.loginWithGoogle(req.body);
    res.json(auth);
  })
];

export const appleLogin = [
  ...appleLoginValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authService.loginWithApple(req.body);
    res.json(auth);
  })
];

export const adminLogin = [
  ...loginValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const auth = await authService.loginAdmin(req.body);
    if (!auth) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }
    res.json(auth);
  })
];

export const refresh = [
  ...refreshValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    const { refreshToken } = req.body as { refreshToken: string };
    const tokens = await authService.refreshTokens(refreshToken);
    res.json(tokens);
  })
];

export const forgotPassword = [
  ...forgotValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    await authService.forgotPassword(req.body.email);
    res.json({ message: 'If the email exists, reset instructions were sent' });
  })
];

export const verifyResetOtp = [
  ...verifyOtpValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    await authService.verifyResetOtp(req.body.email, req.body.code);
    res.json({ message: 'OTP verified' });
  })
];

export const resetPassword = [
  ...resetValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    await authService.resetPassword({
      email: req.body.email,
      code: req.body.code,
      newPassword: req.body.password
    });
    res.json({ message: 'Password updated' });
  })
];

export const changePassword = [
  authenticate,
  authorizeRoles(ROLES.USER),
  ...changeValidators,
  validateAuthRequest,
  asyncHandler(async (req: Request, res: Response) => {
    await authService.changePassword(req.auth!.id, req.body.currentPassword, req.body.newPassword);
    res.json({ message: 'Password updated' });
  })
];

export const deleteAccount = [
  authenticate,
  authorizeRoles(ROLES.USER),
  asyncHandler(async (req: Request, res: Response) => {
    await authService.deleteAccount(req.auth!.id);
    res.status(204).send();
  })
];
