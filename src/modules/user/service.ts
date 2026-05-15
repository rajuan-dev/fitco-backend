import UserModel, { UserDocument } from './model';

interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}

interface ListParams {
  page?: number | string;
  limit?: number | string;
  blocked?: boolean;
}

export const ACTIVITY_LEVEL_OPTIONS = [
  { key: 'standard', label: 'Standard', description: 'Little to no exercise (desk job)' },
  { key: 'sedentary', label: 'Sedentary', description: 'Little to no exercise (desk job)' },
  { key: 'lightly_active', label: 'Lightly Active', description: 'Light exercise 1-3 days/week' },
  { key: 'moderately_active', label: 'Moderately Active', description: 'Moderate exercise 3-5 days/week' },
  { key: 'very_active', label: 'Very Active', description: 'Hard exercise 6-7 days/week' },
  { key: 'extremely_active', label: 'Extremely Active', description: 'Very hard exercise or physical job' }
] as const;

export const GOAL_OPTIONS = [
  { key: 'lose_weight', label: 'Lose Weight', description: 'Create a calorie deficit to lose weight' },
  { key: 'maintain_weight', label: 'Maintain Weight', description: 'Keep your current weight stable' },
  { key: 'gain_weight', label: 'Gain Weight', description: 'Increase calories to gain weight' },
  { key: 'build_muscle', label: 'Build Muscle', description: 'Focus on protein and strength training' }
] as const;

export type ActivityLevelKey = (typeof ACTIVITY_LEVEL_OPTIONS)[number]['key'];
export type GoalKey = (typeof GOAL_OPTIONS)[number]['key'];

interface ProfilePayload {
  age?: number;
  height?: number;
  currentWeight?: number;
  gender?: 'male' | 'female' | 'other';
  activityLevel?: ActivityLevelKey;
  goal?: GoalKey;
}

interface HealthPayload {
  medicalConditions?: string;
  foodAllergies?: string;
}

interface DailyGoalPayload {
  calories: number;
  macroRatio?: {
    proteinPercent: number;
    carbsPercent: number;
    fatPercent: number;
  };
}

const DEFAULT_DAILY_GOAL_CONFIG = {
  calories: 2200,
  macroRatio: {
    proteinPercent: 20,
    carbsPercent: 40,
    fatPercent: 40
  }
} as const;

const normalizeMacroRatio = (macroRatio?: DailyGoalPayload['macroRatio']) => {
  if (!macroRatio) {
    return { proteinPercent: 30, carbsPercent: 40, fatPercent: 30 };
  }

  const proteinPercent = Number(macroRatio.proteinPercent);
  const carbsPercent = Number(macroRatio.carbsPercent);
  const fatPercent = Number(macroRatio.fatPercent);

  if (![proteinPercent, carbsPercent, fatPercent].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Macro ratio values must be numbers greater than or equal to 0.');
  }

  const totalPercent = proteinPercent + carbsPercent + fatPercent;
  if (Math.abs(totalPercent - 100) > 0.01) {
    throw new Error('Macro ratio total must equal 100.');
  }

  return { proteinPercent, carbsPercent, fatPercent };
};

export const buildMacroGoalsFromCalories = (calories: number, macroRatio?: DailyGoalPayload['macroRatio']) => {
  const normalizedRatio = normalizeMacroRatio(macroRatio);

  return {
    calories,
    protein: Number(((calories * (normalizedRatio.proteinPercent / 100)) / 4).toFixed(1)),
    carbs: Number(((calories * (normalizedRatio.carbsPercent / 100)) / 4).toFixed(1)),
    fat: Number(((calories * (normalizedRatio.fatPercent / 100)) / 9).toFixed(1)),
    macroRatio: normalizedRatio
  };
};

export const deriveMacroRatioFromGoals = (calories?: number | null, protein?: number | null, carbs?: number | null, fat?: number | null) => {
  const caloriesValue = Number(calories || 0);
  if (caloriesValue <= 0) {
    return { proteinPercent: 0, carbsPercent: 0, fatPercent: 0 };
  }

  return {
    proteinPercent: Math.round(((Number(protein || 0) * 4) / caloriesValue) * 100),
    carbsPercent: Math.round(((Number(carbs || 0) * 4) / caloriesValue) * 100),
    fatPercent: Math.round(((Number(fat || 0) * 9) / caloriesValue) * 100)
  };
};

export const getDailyGoalConfig = (user?: Pick<UserDocument, 'dailyCalorieGoal' | 'dailyProteinPercent' | 'dailyCarbsPercent' | 'dailyFatPercent' | 'dailyProteinGoal' | 'dailyCarbGoal' | 'dailyFatGoal'> | null) => {
  if (!user) {
    return DEFAULT_DAILY_GOAL_CONFIG;
  }

  const calories = Number(user.dailyCalorieGoal || DEFAULT_DAILY_GOAL_CONFIG.calories);
  const hasStoredPercentages =
    user.dailyProteinPercent !== undefined && user.dailyCarbsPercent !== undefined && user.dailyFatPercent !== undefined;

  if (hasStoredPercentages) {
    return {
      calories,
      macroRatio: {
        proteinPercent: Number(user.dailyProteinPercent),
        carbsPercent: Number(user.dailyCarbsPercent),
        fatPercent: Number(user.dailyFatPercent)
      }
    };
  }

  const hasStoredGoalGrams =
    user.dailyProteinGoal !== undefined && user.dailyCarbGoal !== undefined && user.dailyFatGoal !== undefined;

  if (hasStoredGoalGrams) {
    return {
      calories,
      macroRatio: deriveMacroRatioFromGoals(calories, user.dailyProteinGoal, user.dailyCarbGoal, user.dailyFatGoal)
    };
  }

  return DEFAULT_DAILY_GOAL_CONFIG;
};

export const getUsers = async ({ page = 1, limit = 20, blocked }: ListParams): Promise<PaginatedResult<UserDocument>> => {
  const pageNumber = Number(page) || 1;
  const limitNumber = Number(limit) || 20;
  const skip = (pageNumber - 1) * limitNumber;
  const query: Record<string, unknown> = {};

  if (typeof blocked === 'boolean') {
    query.isBlocked = blocked;
  }

  const [data, total] = await Promise.all([
    UserModel.find(query).select('-password -refreshTokens').sort({ createdAt: -1 }).skip(skip).limit(limitNumber),
    UserModel.countDocuments(query)
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

export const getUserById = (id: string): Promise<UserDocument | null> => {
  return UserModel.findById(id).select('-password -refreshTokens');
};

export const setUserBlockStatus = (id: string, isBlocked: boolean): Promise<UserDocument | null> => {
  const update: Record<string, unknown> = { isBlocked };
  if (isBlocked) {
    // Revoke all active sessions so blocked users cannot refresh existing tokens.
    update.refreshTokens = [];
  }
  return UserModel.findByIdAndUpdate(id, update, { new: true }).select('-password -refreshTokens');
};

export const getMyProfile = (id: string): Promise<UserDocument | null> => {
  return UserModel.findById(id).select('-password -refreshTokens');
};

export const updateProfile = (id: string, payload: ProfilePayload): Promise<UserDocument | null> => {
  const update: Record<string, any> = {};
  if (payload.age !== undefined) update.age = payload.age;
  if (payload.height !== undefined) update.height = payload.height;
  if (payload.currentWeight !== undefined) {
    update.currentWeight = payload.currentWeight;
    update.weight = payload.currentWeight;
  }
  if (payload.gender !== undefined) update.gender = payload.gender;
  if (payload.activityLevel !== undefined) update.activityLevel = payload.activityLevel;
  if (payload.goal !== undefined) {
    update.goal = payload.goal;
    update.goals = payload.goal;
  }

  return UserModel.findByIdAndUpdate(id, update, { new: true }).select('-password -refreshTokens');
};

export const updateHealthInfo = (id: string, payload: HealthPayload): Promise<UserDocument | null> => {
  const update: Record<string, any> = {};
  if (payload.medicalConditions !== undefined) update.medicalConditions = payload.medicalConditions;
  if (payload.foodAllergies !== undefined) update.foodAllergies = payload.foodAllergies;
  return UserModel.findByIdAndUpdate(id, update, { new: true }).select('-password -refreshTokens');
};

export const setDailyGoal = (id: string, payload: DailyGoalPayload): Promise<UserDocument | null> => {
  const calories = Number(payload.calories);
  const macroGoals = buildMacroGoalsFromCalories(calories, payload.macroRatio);

  return UserModel.findByIdAndUpdate(
    id,
    {
      dailyCalorieGoal: macroGoals.calories,
      dailyProteinGoal: macroGoals.protein,
      dailyCarbGoal: macroGoals.carbs,
      dailyFatGoal: macroGoals.fat,
      dailyProteinPercent: macroGoals.macroRatio.proteinPercent,
      dailyCarbsPercent: macroGoals.macroRatio.carbsPercent,
      dailyFatPercent: macroGoals.macroRatio.fatPercent
    },
    { new: true }
  ).select('-password -refreshTokens');
};
