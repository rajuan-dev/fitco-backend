import { Request, Response } from 'express';
import { body } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import * as userService from './service';
import { getSingleQueryParam } from '../../utils/query';
import validate from '../../middlewares/validationMiddleware';

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

const profileValidators = [
  body('age').optional().isInt({ min: 1, max: 120 }),
  body('height').optional().isFloat({ min: 1, max: 300 }),
  body('currentWeight').optional().isFloat({ min: 1, max: 500 }),
  body('gender').optional().isIn(['male', 'female', 'other']),
  body('activityLevel').optional().isIn(userService.ACTIVITY_LEVEL_OPTIONS.map((item) => item.key)),
  body('goal').optional().isIn(userService.GOAL_OPTIONS.map((item) => item.key))
];

const healthValidators = [
  body('medicalConditions').optional().isString().trim(),
  body('foodAllergies').optional().isString().trim()
];

const activityLevelValidators = [
  allowOnlyFields(['activityLevel']),
  body('activityLevel').isIn(userService.ACTIVITY_LEVEL_OPTIONS.map((item) => item.key))
];

const goalValidators = [
  allowOnlyFields(['goal']),
  body('goal').isIn(userService.GOAL_OPTIONS.map((item) => item.key))
];

const dailyGoalValidators = [
  allowOnlyFields(['calories', 'macroRatio']),
  body('calories').isFloat({ gt: 0, max: 10000 }),
  body('macroRatio').optional().isObject(),
  body('macroRatio.proteinPercent').optional().isFloat({ min: 0, max: 100 }),
  body('macroRatio.carbsPercent').optional().isFloat({ min: 0, max: 100 }),
  body('macroRatio.fatPercent').optional().isFloat({ min: 0, max: 100 }),
  body().custom((value) => {
    if (!value?.macroRatio) {
      return true;
    }

    const totalPercent =
      Number(value.macroRatio.proteinPercent || 0) +
      Number(value.macroRatio.carbsPercent || 0) +
      Number(value.macroRatio.fatPercent || 0);

    if (Math.abs(totalPercent - 100) > 0.01) {
      throw new Error('Macro ratio total must equal 100.');
    }

    return true;
  })
];

const completeProfileValidators = [
  allowOnlyFields([
    'age',
    'height',
    'currentWeight',
    'gender',
    'activityLevel',
    'goal',
    'medicalConditions',
    'foodAllergies'
  ]),
  body().custom((value) => {
    if (Object.keys(value).length === 0) {
      throw new Error('At least one field is required');
    }
    return true;
  }),
  ...profileValidators,
  ...healthValidators
];

export const listUsers = asyncHandler(async (req: Request, res: Response) => {
  const page = getSingleQueryParam(req.query.page) ?? '1';
  const limit = getSingleQueryParam(req.query.limit) ?? '20';
  const blockedQuery = getSingleQueryParam(req.query.blocked);
  const blocked =
    blockedQuery === undefined
      ? undefined
      : blockedQuery.toLowerCase() === 'true'
        ? true
        : blockedQuery.toLowerCase() === 'false'
          ? false
          : undefined;

  const result = await userService.getUsers({ page, limit, blocked });
  res.json(result);
});

export const getUserDetails = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getUserById(req.params.id as string);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json(user);
});

export const blockUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.setUserBlockStatus(req.params.id as string, true);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json({ message: 'User blocked', user });
});

export const unblockUser = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.setUserBlockStatus(req.params.id as string, false);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json({ message: 'User unblocked', user });
});

export const getMyProfile = asyncHandler(async (req: Request, res: Response) => {
  const user = await userService.getMyProfile(req.auth!.id);
  if (!user) {
    return res.status(404).json({ message: 'User not found' });
  }
  res.json(user);
});

export const upsertMyProfile = [
  ...profileValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.updateProfile(req.auth!.id, req.body);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ message: 'Profile updated', user });
  })
];

export const upsertMyHealthInfo = [
  ...healthValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.updateHealthInfo(req.auth!.id, req.body);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json({ message: 'Health information updated', user });
  })
];

export const submitOnboarding = [
  ...profileValidators,
  ...healthValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await userService.updateProfile(req.auth!.id, req.body);
    if (!profile) {
      return res.status(404).json({ message: 'User not found' });
    }
    const user = await userService.updateHealthInfo(req.auth!.id, req.body);
    res.json({ message: 'Onboarding information saved', user });
  })
];

export const listActivityLevels = asyncHandler(async (_req: Request, res: Response) => {
  res.json(userService.ACTIVITY_LEVEL_OPTIONS);
});

export const listGoalOptions = asyncHandler(async (_req: Request, res: Response) => {
  res.json(userService.GOAL_OPTIONS);
});

export const setMyActivityLevel = [
  ...activityLevelValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.updateProfile(req.auth!.id, { activityLevel: req.body.activityLevel });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const selection = userService.ACTIVITY_LEVEL_OPTIONS.find((item) => item.key === req.body.activityLevel);
    res.json({ message: 'Activity level updated', selection, user });
  })
];

export const setMyGoal = [
  ...goalValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.updateProfile(req.auth!.id, { goal: req.body.goal });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const selection = userService.GOAL_OPTIONS.find((item) => item.key === req.body.goal);
    res.json({ message: 'Goal updated', selection, user });
  })
];

export const upsertMyCompleteProfile = [
  ...completeProfileValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const profile = await userService.updateProfile(req.auth!.id, req.body);
    if (!profile) {
      return res.status(404).json({ message: 'User not found' });
    }

    const user = await userService.updateHealthInfo(req.auth!.id, req.body);
    const activityLevelSelection =
      req.body.activityLevel !== undefined
        ? userService.ACTIVITY_LEVEL_OPTIONS.find((item) => item.key === req.body.activityLevel)
        : undefined;
    const goalSelection =
      req.body.goal !== undefined ? userService.GOAL_OPTIONS.find((item) => item.key === req.body.goal) : undefined;

    res.json({
      message: 'Profile, health, activity level, and goal updated',
      activityLevelSelection,
      goalSelection,
      user
    });
  })
];

export const setMyDailyGoal = [
  ...dailyGoalValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const user = await userService.setDailyGoal(req.auth!.id, {
      calories: Number(req.body.calories),
      macroRatio: req.body.macroRatio
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const macroRatio = userService.deriveMacroRatioFromGoals(
      user.dailyCalorieGoal,
      user.dailyProteinGoal,
      user.dailyCarbGoal,
      user.dailyFatGoal
    );

    res.json({
      message: 'Daily goal updated',
      dailyGoal: {
        calories: user.dailyCalorieGoal,
        protein: user.dailyProteinGoal,
        carbs: user.dailyCarbGoal,
        fat: user.dailyFatGoal,
        // Old hardcoded response kept here for reference:
        // macroRatio: { proteinPercent: 30, carbsPercent: 40, fatPercent: 30 }
        macroRatio
      },
      user
    });
  })
];
