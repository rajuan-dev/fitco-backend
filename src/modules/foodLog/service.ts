import mongoose from 'mongoose';
import FoodDatabaseModel, { FoodServingUnit } from '../foodDatabase/model';
import FoodLogModel, { FOOD_LOG_MEALS, FOOD_LOG_SOURCES, FoodLogDocument, FoodLogMeal, FoodLogSource } from './model';
import UserModel, { UserDocument } from '../user/model';
import { getDailyGoalConfig } from '../user/service';

interface DailyGoalValues {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface FoodLogInput {
  foodId?: string;
  meal?: FoodLogMeal;
  servings?: number;
  servingSize?: number;
  servingUnit?: FoodServingUnit;
  loggedAt?: string | Date;
}

interface ListFoodLogsParams {
  userId: string;
  date?: string;
  meal?: string;
}

interface WeeklySummaryDay {
  date: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  hasLog: boolean;
  hitGoal: boolean;
}

interface ListLogFoodsParams {
  userId: string;
  page?: number | string;
  limit?: number | string;
  search?: string;
}

interface LogFoodListItem {
  id: string;
  source: FoodLogSource;
  foodName: string;
  brandName: string;
  servingSize: number;
  servingUnit: FoodServingUnit;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  barcode?: string;
  createdAt: Date;
}

interface LogFoodListResponse {
  data: LogFoodListItem[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    pages: number;
  };
}

interface AggregateLogFoodListItem extends Omit<LogFoodListItem, 'servingSize' | 'servingUnit'> {
  servingSize: number;
  servingUnit: FoodServingUnit;
  createdByUser?: string;
  sortPriority?: number;
}

interface FoodPreviewResponse {
  food: {
    id: string;
    source: FoodLogSource;
    name: string;
    brandName: string;
  };
  selection: {
    meal: FoodLogMeal;
    servings: number;
    servingSize: number;
    servingUnit: FoodServingUnit;
    baseServingSize: number;
    baseServingUnit: FoodServingUnit;
    servingLabel: string;
  };
  nutrition: {
    calories: number;
    protein: { grams: number; percentage: number };
    carbs: { grams: number; percentage: number };
    fat: { grams: number; percentage: number };
  };
  dailyGoals: {
    calories: { value: number; target: number; percentage: number };
    protein: { value: number; target: number; percentage: number };
    carbs: { value: number; target: number; percentage: number };
    fat: { value: number; target: number; percentage: number };
  };
}

interface HomeDataResponse {
  date: string;
  dailyGoal: {
    calories: number;
    macroRatio: {
      proteinPercent: number;
      carbsPercent: number;
      fatPercent: number;
    };
  };
  goals: DailyGoalValues;
  totals: DailyGoalValues;
  remaining: DailyGoalValues;
  progressPercent: DailyGoalValues;
  meals: {
    breakfast: FoodLogDocument[];
    lunch: FoodLogDocument[];
    dinner: FoodLogDocument[];
  };
}

export interface WeeklySummaryResponse {
  weekStart: string;
  weekEnd: string;
  goals: DailyGoalValues;
  avgCalories: number;
  goalHits: number;
  bestDay: WeeklySummaryDay | null;
  daysCompleted: number;
  progressDays: number;
  days: WeeklySummaryDay[];
}

const DEFAULT_DAILY_GOALS: DailyGoalValues = {
  calories: 2000,
  protein: 150,
  carbs: 250,
  fat: 67
};

const ACTIVITY_MULTIPLIERS: Record<string, number> = {
  standard: 1.2,
  sedentary: 1.2,
  lightly_active: 1.375,
  moderately_active: 1.55,
  very_active: 1.725,
  extremely_active: 1.9
};

const GOAL_CALORIE_ADJUSTMENT: Record<string, number> = {
  lose_weight: -400,
  maintain_weight: 0,
  gain_weight: 300,
  build_muscle: 200
};

const GOAL_PROTEIN_MULTIPLIER: Record<string, number> = {
  lose_weight: 2,
  maintain_weight: 1.6,
  gain_weight: 1.8,
  build_muscle: 2.2
};

const GOAL_FAT_RATIO: Record<string, number> = {
  lose_weight: 0.25,
  maintain_weight: 0.3,
  gain_weight: 0.27,
  build_muscle: 0.25
};

const createHttpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });

const roundTo = (value: number, digits = 1): number => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

const formatServingLabel = (servings: number, servingSize: number, servingUnit: FoodServingUnit): string => {
  const servingsLabel = `${roundTo(servings, 2)} serving${servings === 1 ? '' : 's'}`;
  return `${servingsLabel} (${roundTo(servingSize, 2)}${servingUnit})`;
};

const calculatePercent = (value: number, target: number): number => {
  if (target <= 0) {
    return 0;
  }

  return Math.round((value / target) * 100);
};

const normalizeLoggedAt = (value?: string | Date): Date => {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError('Invalid loggedAt value', 400);
  }

  return parsed;
};

const getDateKeyUTC = (date: Date): string => date.toISOString().slice(0, 10);

const getDayWindowUTC = (date: Date): { start: Date; end: Date } => {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
  return { start, end };
};

const parseDateInput = (dateValue?: string): Date => {
  if (!dateValue) {
    return new Date();
  }
  const parsed = new Date(`${dateValue}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError('Invalid date. Use YYYY-MM-DD.', 400);
  }
  return parsed;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const inputToObjectId = (value: string): mongoose.Types.ObjectId => new mongoose.Types.ObjectId(value);

interface FoodSelectionDetails {
  foodId: string;
  foodSource: FoodLogSource;
  foodName: string;
  brandName: string;
  baseServingSize: number;
  baseServingUnit: FoodServingUnit;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

const buildPreviewFromFoodDetails = (
  selectedFood: FoodSelectionDetails,
  user: UserDocument | null,
  input: FoodLogInput
): FoodPreviewResponse & { loggedAt: Date } => {
  const servings = Number(input.servings ?? 1);
  const servingSize = Number(input.servingSize ?? selectedFood.baseServingSize);
  const servingUnit = input.servingUnit ?? selectedFood.baseServingUnit;
  const meal = input.meal ?? 'breakfast';

  if (!FOOD_LOG_MEALS.includes(meal)) {
    throw createHttpError('Invalid meal value', 400);
  }

  if (!Number.isFinite(servings) || servings <= 0) {
    throw createHttpError('Servings must be greater than 0', 400);
  }

  if (!Number.isFinite(servingSize) || servingSize <= 0) {
    throw createHttpError('Serving size must be greater than 0', 400);
  }

  if (servingUnit !== selectedFood.baseServingUnit) {
    throw createHttpError(`Serving unit must match the food unit: ${selectedFood.baseServingUnit}`, 400);
  }

  const multiplier = (servings * servingSize) / selectedFood.baseServingSize;
  const calories = Math.round(selectedFood.calories * multiplier);
  const protein = roundTo(selectedFood.protein * multiplier);
  const carbs = roundTo(selectedFood.carbs * multiplier);
  const fat = roundTo(selectedFood.fat * multiplier);
  const macroTotal = protein + carbs + fat;
  const dailyGoalTargets = buildDailyGoals(user);
  const loggedAt = normalizeLoggedAt(input.loggedAt);

  return {
    food: {
      id: selectedFood.foodId,
      source: selectedFood.foodSource,
      name: selectedFood.foodName,
      brandName: selectedFood.brandName
    },
    selection: {
      meal,
      servings: roundTo(servings, 2),
      servingSize: roundTo(servingSize, 2),
      servingUnit,
      baseServingSize: roundTo(selectedFood.baseServingSize, 2),
      baseServingUnit: selectedFood.baseServingUnit,
      servingLabel: formatServingLabel(servings, servingSize, servingUnit)
    },
    nutrition: {
      calories,
      protein: {
        grams: protein,
        percentage: macroTotal > 0 ? Math.round((protein / macroTotal) * 100) : 0
      },
      carbs: {
        grams: carbs,
        percentage: macroTotal > 0 ? Math.round((carbs / macroTotal) * 100) : 0
      },
      fat: {
        grams: fat,
        percentage: macroTotal > 0 ? Math.round((fat / macroTotal) * 100) : 0
      }
    },
    dailyGoals: {
      calories: {
        value: calories,
        target: dailyGoalTargets.calories,
        percentage: calculatePercent(calories, dailyGoalTargets.calories)
      },
      protein: {
        value: protein,
        target: dailyGoalTargets.protein,
        percentage: calculatePercent(protein, dailyGoalTargets.protein)
      },
      carbs: {
        value: carbs,
        target: dailyGoalTargets.carbs,
        percentage: calculatePercent(carbs, dailyGoalTargets.carbs)
      },
      fat: {
        value: fat,
        target: dailyGoalTargets.fat,
        percentage: calculatePercent(fat, dailyGoalTargets.fat)
      }
    },
    loggedAt
  };
};

const loadSelectedFood = async (userId: string, input: FoodLogInput): Promise<FoodSelectionDetails> => {
  if (!input.foodId) {
    throw createHttpError('foodId is required', 400);
  }

  const foodRef = String(input.foodId).trim();
  const isObjectId = mongoose.isValidObjectId(foodRef);

  const databaseFood = isObjectId ? await FoodDatabaseModel.findById(foodRef) : await FoodDatabaseModel.findOne({ barcode: foodRef });
  if (databaseFood) {
    return {
      foodId: databaseFood._id.toString(),
      foodSource: FOOD_LOG_SOURCES[0],
      foodName: databaseFood.product,
      brandName: databaseFood.brand || '',
      baseServingSize: databaseFood.servingSize,
      baseServingUnit: databaseFood.servingUnit,
      calories: databaseFood.calories,
      protein: databaseFood.protein,
      carbs: databaseFood.carbs,
      fat: databaseFood.fat
    };
  }

  throw createHttpError('Food item not found', 404);
};

const buildCalculatedDailyGoals = (user: UserDocument | null): DailyGoalValues => {
  if (!user) {
    return DEFAULT_DAILY_GOALS;
  }

  const weight = Number(user.currentWeight ?? user.weight ?? 70);
  const height = Number(user.height ?? 170);
  const age = Number(user.age ?? 30);
  const activityLevel = user.activityLevel ?? 'standard';
  const goal = user.goal ?? 'maintain_weight';

  const genderOffset = user.gender === 'female' ? -161 : user.gender === 'male' ? 5 : -78;
  const bmr = 10 * weight + 6.25 * height - 5 * age + genderOffset;
  const activityMultiplier = ACTIVITY_MULTIPLIERS[activityLevel] ?? ACTIVITY_MULTIPLIERS.standard;
  const calorieTarget = Math.max(1200, Math.round(bmr * activityMultiplier + (GOAL_CALORIE_ADJUSTMENT[goal] ?? 0)));
  const proteinTarget = Math.max(60, Math.round(weight * (GOAL_PROTEIN_MULTIPLIER[goal] ?? 1.6)));
  const fatTarget = Math.max(35, Math.round((calorieTarget * (GOAL_FAT_RATIO[goal] ?? 0.3)) / 9));
  const carbCalories = calorieTarget - proteinTarget * 4 - fatTarget * 9;
  const carbTarget = Math.max(50, Math.round(carbCalories / 4));

  return {
    calories: calorieTarget,
    protein: proteinTarget,
    carbs: carbTarget,
    fat: fatTarget
  };
};

const buildDailyGoals = (user: UserDocument | null): DailyGoalValues => {
  if (user?.dailyCalorieGoal && user?.dailyProteinGoal !== undefined && user?.dailyCarbGoal !== undefined && user?.dailyFatGoal !== undefined) {
    return {
      calories: Number(user.dailyCalorieGoal),
      protein: Number(user.dailyProteinGoal),
      carbs: Number(user.dailyCarbGoal),
      fat: Number(user.dailyFatGoal)
    };
  }

  return buildCalculatedDailyGoals(user);
};

const buildPreviewFromSelection = async (userId: string, input: FoodLogInput): Promise<FoodPreviewResponse & { loggedAt: Date }> => {
  const [selectedFood, user] = await Promise.all([loadSelectedFood(userId, input), UserModel.findById(userId)]);
  return buildPreviewFromFoodDetails(selectedFood, user, input);
};

export const previewFoodLog = async (userId: string, input: FoodLogInput): Promise<FoodPreviewResponse> => {
  const preview = await buildPreviewFromSelection(userId, input);
  return preview;
};

export const createFoodLog = async (userId: string, input: FoodLogInput): Promise<FoodLogDocument> => {
  const preview = await buildPreviewFromSelection(userId, input);

  return FoodLogModel.create({
    user: userId,
    food: preview.food.id,
    foodSource: preview.food.source,
    foodName: preview.food.name,
    brandName: preview.food.brandName || '',
    meal: preview.selection.meal,
    servings: preview.selection.servings,
    servingSize: preview.selection.servingSize,
    servingUnit: preview.selection.servingUnit,
    baseServingSize: preview.selection.baseServingSize,
    baseServingUnit: preview.selection.baseServingUnit,
    calories: preview.nutrition.calories,
    protein: preview.nutrition.protein.grams,
    carbs: preview.nutrition.carbs.grams,
    fat: preview.nutrition.fat.grams,
    macroBreakdown: {
      protein: preview.nutrition.protein,
      carbs: preview.nutrition.carbs,
      fat: preview.nutrition.fat
    },
    dailyGoals: preview.dailyGoals,
    loggedAt: preview.loggedAt
  });
};

export const deleteFoodLog = async (userId: string, foodLogId: string): Promise<FoodLogDocument | null> => {
  if (!mongoose.isValidObjectId(foodLogId)) {
    throw createHttpError('Invalid food log id', 400);
  }

  return FoodLogModel.findOneAndDelete({ _id: foodLogId, user: userId });
};

export const updateFoodLog = async (userId: string, foodLogId: string, input: FoodLogInput): Promise<FoodLogDocument | null> => {
  if (!mongoose.isValidObjectId(foodLogId)) {
    throw createHttpError('Invalid food log id', 400);
  }

  const existingLog = await FoodLogModel.findOne({ _id: foodLogId, user: userId });
  if (!existingLog) {
    return null;
  }

  const [selectedFood, user] = await Promise.all([
    loadSelectedFood(userId, { foodId: existingLog.food.toString() }),
    UserModel.findById(userId)
  ]);

  const preview = buildPreviewFromFoodDetails(selectedFood, user, {
    meal: input.meal ?? existingLog.meal,
    servings: input.servings ?? existingLog.servings,
    servingSize: input.servingSize ?? existingLog.servingSize,
    servingUnit: input.servingUnit ?? existingLog.servingUnit,
    loggedAt: input.loggedAt ?? existingLog.loggedAt
  });

  existingLog.food = inputToObjectId(preview.food.id);
  existingLog.foodSource = preview.food.source;
  existingLog.foodName = preview.food.name;
  existingLog.brandName = preview.food.brandName || '';
  existingLog.meal = preview.selection.meal;
  existingLog.servings = preview.selection.servings;
  existingLog.servingSize = preview.selection.servingSize;
  existingLog.servingUnit = preview.selection.servingUnit;
  existingLog.baseServingSize = preview.selection.baseServingSize;
  existingLog.baseServingUnit = preview.selection.baseServingUnit;
  existingLog.calories = preview.nutrition.calories;
  existingLog.protein = preview.nutrition.protein.grams;
  existingLog.carbs = preview.nutrition.carbs.grams;
  existingLog.fat = preview.nutrition.fat.grams;
  existingLog.macroBreakdown = {
    protein: preview.nutrition.protein,
    carbs: preview.nutrition.carbs,
    fat: preview.nutrition.fat
  };
  existingLog.dailyGoals = preview.dailyGoals;
  existingLog.loggedAt = preview.loggedAt;

  await existingLog.save();
  return existingLog;
};

export const listFoodLogs = async ({ userId, date, meal }: ListFoodLogsParams): Promise<FoodLogDocument[]> => {
  const query: Record<string, unknown> = { user: userId };

  if (meal) {
    if (!FOOD_LOG_MEALS.includes(meal as FoodLogMeal)) {
      throw createHttpError('Invalid meal filter', 400);
    }
    query.meal = meal;
  }

  if (date) {
    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw createHttpError('Invalid date filter. Use YYYY-MM-DD.', 400);
    }

    query.loggedAt = { $gte: start, $lte: end };
  }

  return FoodLogModel.find(query).sort({ loggedAt: -1, _id: -1 });
};

export const listLogFoods = async ({ userId, page = 1, limit = 20, search = '' }: ListLogFoodsParams): Promise<LogFoodListResponse> => {
  const pageNumber = Math.max(1, Number(page) || 1);
  const limitNumber = Math.max(1, Math.min(100, Number(limit) || 20));
  const skip = (pageNumber - 1) * limitNumber;
  const normalizedSearch = String(search).trim();
  const dbSearchRegex = normalizedSearch ? new RegExp(escapeRegex(normalizedSearch), 'i') : null;
  const userObjectId = inputToObjectId(userId);

  const databaseMatch: Record<string, unknown> = dbSearchRegex
    ? {
        $or: [{ brand: dbSearchRegex }, { product: dbSearchRegex }, { barcode: dbSearchRegex }]
      }
    : {};
  const basePipeline: any[] = [
    { $match: databaseMatch },
    {
      $addFields: {
        sortPriority: {
          $cond: [{ $eq: ['$createdByUser', userObjectId] }, 0, 1]
        }
      }
    },
    {
      $project: {
        _id: 0,
        id: { $toString: '$_id' },
        source: { $literal: 'database' },
        foodName: '$product',
        brandName: '$brand',
        servingSize: '$servingSize',
        servingUnit: '$servingUnit',
        calories: '$calories',
        protein: '$protein',
        carbs: '$carbs',
        fat: '$fat',
        barcode: '$barcode',
        createdAt: '$createdAt',
        createdByUser: { $cond: [{ $ifNull: ['$createdByUser', false] }, { $toString: '$createdByUser' }, null] },
        sortPriority: '$sortPriority'
      }
    }
  ];

  const [data, countRows] = await Promise.all([
    FoodDatabaseModel.aggregate([
      ...basePipeline,
      { $sort: { sortPriority: 1, createdAt: -1, id: -1 } },
      { $skip: skip },
      { $limit: limitNumber }
    ]),
    FoodDatabaseModel.aggregate([...basePipeline, { $count: 'total' }])
  ]);

  const total = Number(countRows[0]?.total || 0);
  const normalizedData: LogFoodListItem[] = (data as AggregateLogFoodListItem[]).map((item) => {
    const { createdByUser: _createdByUser, sortPriority: _sortPriority, ...normalizedItem } = item;
    return normalizedItem;
  });

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

export const getHomeData = async (userId: string, dateValue?: string): Promise<HomeDataResponse> => {
  const date = parseDateInput(dateValue);
  const { start, end } = getDayWindowUTC(date);
  const userObjectId = inputToObjectId(userId);
  const [user, logs, totalsRow] = await Promise.all([
    UserModel.findById(userId),
    FoodLogModel.find({ user: userId, loggedAt: { $gte: start, $lte: end } }).sort({ loggedAt: -1, _id: -1 }),
    FoodLogModel.aggregate([
      { $match: { user: userObjectId, loggedAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: null,
          calories: { $sum: '$calories' },
          protein: { $sum: '$protein' },
          carbs: { $sum: '$carbs' },
          fat: { $sum: '$fat' }
        }
      }
    ])
  ]);

  const goals = buildDailyGoals(user);
  const totalsRaw = totalsRow[0] || {};
  const totals = {
    calories: Math.round(Number(totalsRaw.calories || 0)),
    protein: roundTo(Number(totalsRaw.protein || 0)),
    carbs: roundTo(Number(totalsRaw.carbs || 0)),
    fat: roundTo(Number(totalsRaw.fat || 0))
  };
  const remaining = {
    calories: Math.max(goals.calories - totals.calories, 0),
    protein: roundTo(Math.max(goals.protein - totals.protein, 0)),
    carbs: roundTo(Math.max(goals.carbs - totals.carbs, 0)),
    fat: roundTo(Math.max(goals.fat - totals.fat, 0))
  };
  const progressPercent = {
    calories: calculatePercent(totals.calories, goals.calories),
    protein: calculatePercent(totals.protein, goals.protein),
    carbs: calculatePercent(totals.carbs, goals.carbs),
    fat: calculatePercent(totals.fat, goals.fat)
  };

  return {
    date: getDateKeyUTC(date),
    dailyGoal: getDailyGoalConfig(user),
    goals,
    totals,
    remaining,
    progressPercent,
    meals: {
      breakfast: logs.filter((log) => log.meal === 'breakfast'),
      lunch: logs.filter((log) => log.meal === 'lunch'),
      dinner: logs.filter((log) => log.meal === 'dinner')
    }
  };
};

export const getWeeklySummary = async (userId: string, startDateValue?: string): Promise<WeeklySummaryResponse> => {
  const baseDate = parseDateInput(startDateValue);
  const weekStart = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 0, 0, 0, 0));
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);
  const userObjectId = inputToObjectId(userId);

  const [user, rows] = await Promise.all([
    UserModel.findById(userId),
    FoodLogModel.aggregate([
      { $match: { user: userObjectId, loggedAt: { $gte: weekStart, $lte: weekEnd } } },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$loggedAt' }
          },
          calories: { $sum: '$calories' },
          protein: { $sum: '$protein' },
          carbs: { $sum: '$carbs' },
          fat: { $sum: '$fat' }
        }
      },
      { $sort: { _id: 1 } }
    ])
  ]);

  const goals = buildDailyGoals(user);
  const dayMap = new Map<string, { calories: number; protein: number; carbs: number; fat: number }>();
  rows.forEach((row) => {
    dayMap.set(String(row._id), {
      calories: Math.round(Number(row.calories || 0)),
      protein: roundTo(Number(row.protein || 0)),
      carbs: roundTo(Number(row.carbs || 0)),
      fat: roundTo(Number(row.fat || 0))
    });
  });

  const days: WeeklySummaryDay[] = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const date = new Date(weekStart);
    date.setUTCDate(weekStart.getUTCDate() + offset);
    const key = getDateKeyUTC(date);
    const dayTotals = dayMap.get(key);
    const calories = dayTotals?.calories || 0;
    const protein = dayTotals?.protein || 0;
    const carbs = dayTotals?.carbs || 0;
    const fat = dayTotals?.fat || 0;
    const hasLog = Boolean(dayTotals);
    const hitGoal = hasLog && calories >= goals.calories && protein >= goals.protein && carbs >= goals.carbs && fat >= goals.fat;

    days.push({ date: key, calories, protein, carbs, fat, hasLog, hitGoal });
  }

  const loggedDays = days.filter((day) => day.hasLog);
  const avgCalories = loggedDays.length > 0 ? Math.round(loggedDays.reduce((sum, day) => sum + day.calories, 0) / loggedDays.length) : 0;
  const bestDay = loggedDays.reduce<WeeklySummaryDay | null>((best, day) => {
    if (!best || day.calories > best.calories) return day;
    return best;
  }, null);

  return {
    weekStart: getDateKeyUTC(weekStart),
    weekEnd: getDateKeyUTC(weekEnd),
    goals,
    avgCalories,
    goalHits: days.filter((day) => day.hitGoal).length,
    bestDay,
    daysCompleted: loggedDays.length,
    progressDays: loggedDays.length,
    days
  };
};
