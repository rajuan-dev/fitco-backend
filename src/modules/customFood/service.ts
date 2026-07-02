import mongoose from 'mongoose';
import FoodDatabaseModel, { FoodDatabaseDocument, FoodServingUnit } from '../foodDatabase/model';
import * as foodDatabaseService from '../foodDatabase/service';
import openai from '../../config/openai';
import { FOOD_LOG_MEALS, FoodLogMeal } from '../foodLog/model';
import FoodLogModel from '../foodLog/model';
import UserModel from '../user/model';
import { buildMacroGoalsFromCalories, getDailyGoalConfig } from '../user/service';
import { uploadBufferToS3 } from '../upload/service';

interface CreateCustomFoodPayload {
  barcode?: string;
  foodName?: string;
  brandName?: string;
  servingSize?: string;
  calories?: number | string;
  protein?: number | string;
  carbs?: number | string;
  fat?: number | string;
  fats?: number | string;
}

interface CustomFoodListItem {
  id: string;
  barcode?: string;
  foodName: string;
  brandName: string;
  servingSize: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ScanBarcodeResponse {
  source: 'database';
  id: string;
  barcode?: string;
  foodName: string;
  brandName: string;
  servingSize: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

interface ScanAiMealPayload {
  imageBase64?: string;
  imageUrl?: string;
  mimeType?: string;
  servingDescription?: string;
}

interface AiMealScanResponse {
  source: 'ai';
  foodName: string;
  servingSize: string;
  confidence: number;
  nutritionFacts: {
    calories: { value: number; unit: 'kcal' };
    protein: { value: number; unit: 'g' };
    carbs: { value: number; unit: 'g' };
    fats: { value: number; unit: 'g' };
  };
  calories: number;
  protein: number;
  carbs: number;
  fats: number;
  notes: string;
}

interface SaveAiMealPayload extends ScanAiMealPayload {
  meal: FoodLogMeal;
  foodName: string;
  confidence?: number;
  nutritionFacts?: {
    calories?: { value?: number | string };
    protein?: { value?: number | string };
    carbs?: { value?: number | string };
    fats?: { value?: number | string };
  };
  calories?: number | string;
  protein?: number | string;
  carbs?: number | string;
  fats?: number | string;
  fat?: number | string;
  notes?: string;
  loggedAt?: string;
}

interface SavedAiMealResponse {
  message: string;
  foodLog: {
    id: string;
    foodId: string;
    meal: FoodLogMeal;
    foodName: string;
    imageUrl: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    confidence: number;
    notes: string;
    loggedAt: Date;
  };
}

interface DeleteAiMealResponse {
  message: string;
  deletedFoodLog: {
    id: string;
    meal: FoodLogMeal;
    foodName: string;
    imageUrl: string;
    loggedAt: Date;
  };
}

interface ListCustomFoodParams {
  userId: string;
  search?: string;
}

const createHttpError = (message: string, statusCode: number) => Object.assign(new Error(message), { statusCode });
const SUPPORTED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const normalizeBarcode = (barcode?: string): string | undefined => {
  const normalized = String(barcode || '').trim();
  return normalized || undefined;
};

const parseServingSize = (value?: string): { servingSize: number; servingUnit: FoodServingUnit } => {
  const normalizedValue = String(value || '').trim().toLowerCase();
  const match = normalizedValue.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/i);

  if (!match) {
    throw createHttpError('servingSize must be like 100g, 250ml, or 1piece', 400);
  }

  const servingSize = Number(match[1]);
  const unitAliases: Record<string, FoodServingUnit> = {
    g: 'g',
    gram: 'g',
    grams: 'g',
    ml: 'ml',
    milliliter: 'ml',
    milliliters: 'ml',
    piece: 'piece',
    pieces: 'piece',
    pc: 'piece',
    pcs: 'piece'
  };
  const servingUnit = unitAliases[match[2]];

  if (!Number.isFinite(servingSize) || servingSize <= 0 || !servingUnit) {
    throw createHttpError('servingSize must be like 100g, 250ml, or 1piece', 400);
  }

  return { servingSize, servingUnit };
};

const formatServingSize = (servingSize: number, servingUnit: FoodServingUnit): string => `${servingSize}${servingUnit}`;

const roundNutrition = (value: unknown, fallback = 0): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return fallback;
  return Math.round(numeric);
};

const normalizeConfidence = (value: unknown): number => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0.7;
  return Math.min(1, Math.max(0, Math.round(numeric * 100) / 100));
};

const normalizeImageMimeType = (value?: string): string => {
  const mimeType = String(value || 'image/jpeg').trim().toLowerCase();

  if (!mimeType.startsWith('image/')) {
    throw createHttpError('mimeType must be an image MIME type', 400);
  }

  return mimeType;
};

const resolveMealImageUrl = (payload: ScanAiMealPayload): string => {
  const imageUrl = String(payload.imageUrl || '').trim();
  if (imageUrl) {
    if (!/^https?:\/\//i.test(imageUrl) && !imageUrl.startsWith('data:image/')) {
      throw createHttpError('imageUrl must be an http(s) URL or a data image URL', 400);
    }
    return imageUrl;
  }

  const rawBase64 = String(payload.imageBase64 || '').trim();
  if (!rawBase64) {
    throw createHttpError('imageBase64 or imageUrl is required', 400);
  }

  if (rawBase64.startsWith('data:image/')) {
    return rawBase64;
  }

  const mimeType = normalizeImageMimeType(payload.mimeType);
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw createHttpError('mimeType must be image/jpeg, image/png, or image/webp', 400);
  }

  const normalizedBase64 = rawBase64.replace(/\s/g, '');
  if (!/^[a-z0-9+/]+={0,2}$/i.test(normalizedBase64)) {
    throw createHttpError('imageBase64 must be a valid base64 encoded image', 400);
  }

  return `data:${mimeType};base64,${normalizedBase64}`;
};

const resolveImageBufferUpload = async (payload: ScanAiMealPayload): Promise<string> => {
  const imageUrl = String(payload.imageUrl || '').trim();

  if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
    return imageUrl;
  }

  let dataUrl = imageUrl;

  if (!dataUrl) {
    const rawBase64 = String(payload.imageBase64 || '').trim();
    if (!rawBase64) {
      throw createHttpError('imageBase64 or imageUrl is required', 400);
    }

    const mimeType = normalizeImageMimeType(payload.mimeType);
    const normalizedBase64 = rawBase64.startsWith('data:image/')
      ? rawBase64
      : `data:${mimeType};base64,${rawBase64.replace(/\s/g, '')}`;

    dataUrl = normalizedBase64;
  }

  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/i);
  if (!match) {
    throw createHttpError('imageBase64 or imageUrl must contain a valid image', 400);
  }

  const contentType = normalizeImageMimeType(match[1]);
  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length) {
    throw createHttpError('Image is empty', 400);
  }

  const extension = contentType.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'jpg';
  const uploadedImage = await uploadBufferToS3({
    buffer,
    mimeType: contentType,
    originalName: `ai-meal-scan.${extension}`,
    folder: 'meal-scans'
  });

  return uploadedImage.url;
};

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10;

const resolveAiNutritionValues = (payload: SaveAiMealPayload) => {
  const nutrition = payload.nutritionFacts || {};

  const calories = roundNutrition(nutrition.calories?.value ?? payload.calories);
  const protein = roundToOneDecimal(Number(nutrition.protein?.value ?? payload.protein ?? 0));
  const carbs = roundToOneDecimal(Number(nutrition.carbs?.value ?? payload.carbs ?? 0));
  const fat = roundToOneDecimal(Number(nutrition.fats?.value ?? payload.fats ?? payload.fat ?? 0));

  if (calories < 0 || protein < 0 || carbs < 0 || fat < 0) {
    throw createHttpError('Nutrition values must be zero or greater', 400);
  }

  return { calories, protein, carbs, fat };
};

const parseLoggedAt = (value?: string): Date => {
  if (!value) {
    return new Date();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw createHttpError('Invalid loggedAt value', 400);
  }

  return parsed;
};

const parseLoggedAtOrFallback = (value: string | undefined, fallback: Date): Date => {
  if (value === undefined) {
    return fallback;
  }

  return parseLoggedAt(value);
};

const getMacroBreakdown = (protein: number, carbs: number, fat: number) => {
  const total = protein + carbs + fat;
  const toPercent = (grams: number) => (total > 0 ? Math.round((grams / total) * 100) : 0);

  return {
    protein: { grams: protein, percentage: toPercent(protein) },
    carbs: { grams: carbs, percentage: toPercent(carbs) },
    fat: { grams: fat, percentage: toPercent(fat) }
  };
};

const getDailyGoalProgress = (
  goalConfig: ReturnType<typeof getDailyGoalConfig>,
  calories: number,
  protein: number,
  carbs: number,
  fat: number
) => {
  const macroGoals = buildMacroGoalsFromCalories(goalConfig.calories, goalConfig.macroRatio);

  return {
    calories: {
      value: calories,
      target: macroGoals.calories,
      percentage: macroGoals.calories > 0 ? Math.round((calories / macroGoals.calories) * 100) : 0
    },
    protein: {
      value: protein,
      target: macroGoals.protein,
      percentage: macroGoals.protein > 0 ? Math.round((protein / macroGoals.protein) * 100) : 0
    },
    carbs: {
      value: carbs,
      target: macroGoals.carbs,
      percentage: macroGoals.carbs > 0 ? Math.round((carbs / macroGoals.carbs) * 100) : 0
    },
    fat: {
      value: fat,
      target: macroGoals.fat,
      percentage: macroGoals.fat > 0 ? Math.round((fat / macroGoals.fat) * 100) : 0
    }
  };
};

const isAiMealLog = (foodLog: {
  foodSource?: string;
  brandName?: string;
}): boolean => foodLog.foodSource === 'custom' && foodLog.brandName === 'AI Meal Scan';

const getAiMealFoodLog = async (userId: string, foodLogId: string) => {
  if (!mongoose.isValidObjectId(foodLogId)) {
    throw createHttpError('Invalid food log id', 400);
  }

  const foodLog = await FoodLogModel.findOne({ _id: foodLogId, user: userId });
  if (!foodLog) {
    throw createHttpError('AI meal log not found', 404);
  }

  if (!isAiMealLog(foodLog)) {
    throw createHttpError('This food log is not an AI meal scan entry', 400);
  }

  return foodLog;
};

const buildAiMealResponse = (
  message: string,
  foodLog: {
    _id: { toString(): string };
    meal: FoodLogMeal;
    foodName: string;
    imageUrl?: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    loggedAt: Date;
  },
  meta: {
    foodId: string;
    confidence?: number;
    notes?: string;
  }
): SavedAiMealResponse => ({
  message,
  foodLog: {
    id: foodLog._id.toString(),
    foodId: meta.foodId,
    meal: foodLog.meal,
    foodName: foodLog.foodName,
    imageUrl: foodLog.imageUrl || '',
    calories: foodLog.calories,
    protein: foodLog.protein,
    carbs: foodLog.carbs,
    fat: foodLog.fat,
    confidence: normalizeConfidence(meta.confidence),
    notes: String(meta.notes || 'Estimated from the submitted meal image.').trim(),
    loggedAt: foodLog.loggedAt
  }
});

const parseAiMealJson = (content: string): Record<string, unknown> => {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      throw createHttpError('AI meal scanner returned an unreadable response', 502);
    }
    return JSON.parse(match[0]);
  }
};

const mapAiMealResponse = (payload: Record<string, unknown>): AiMealScanResponse => {
  const nutrition = (payload.nutritionFacts || payload.nutrition || {}) as Record<string, unknown>;
  const calories = roundNutrition((nutrition.calories as any)?.value ?? nutrition.calories ?? payload.calories);
  const protein = roundNutrition((nutrition.protein as any)?.value ?? nutrition.protein ?? payload.protein);
  const carbs = roundNutrition((nutrition.carbs as any)?.value ?? nutrition.carbs ?? payload.carbs);
  const fats = roundNutrition((nutrition.fats as any)?.value ?? nutrition.fats ?? nutrition.fat ?? payload.fats ?? payload.fat);

  return {
    source: 'ai',
    foodName: String(payload.foodName || payload.name || 'Unknown meal').trim(),
    servingSize: String(payload.servingSize || '1 serving').trim(),
    confidence: normalizeConfidence(payload.confidence),
    nutritionFacts: {
      calories: { value: calories, unit: 'kcal' },
      protein: { value: protein, unit: 'g' },
      carbs: { value: carbs, unit: 'g' },
      fats: { value: fats, unit: 'g' }
    },
    calories,
    protein,
    carbs,
    fats,
    notes: String(payload.notes || 'Estimated from the submitted meal image.').trim()
  };
};

const mapFoodToCustomFood = (food: FoodDatabaseDocument): CustomFoodListItem => ({
  id: food._id.toString(),
  barcode: food.barcode,
  foodName: food.product,
  brandName: food.brand || '',
  servingSize: formatServingSize(food.servingSize, food.servingUnit),
  calories: Number(food.calories || 0),
  protein: Number(food.protein || 0),
  carbs: Number(food.carbs || 0),
  fat: Number(food.fat || 0),
  createdAt: food.createdAt,
  updatedAt: food.updatedAt
});

const mapFoodToScanResponse = (food: FoodDatabaseDocument): ScanBarcodeResponse => ({
  source: 'database',
  id: food._id.toString(),
  barcode: food.barcode,
  foodName: food.product,
  brandName: food.brand || '',
  servingSize: formatServingSize(food.servingSize, food.servingUnit),
  calories: Number(food.calories || 0),
  protein: Number(food.protein || 0),
  carbs: Number(food.carbs || 0),
  fat: Number(food.fat || 0)
});

export const createCustomFood = async (userId: string, payload: CreateCustomFoodPayload): Promise<CustomFoodListItem> => {
  const serving = parseServingSize(payload.servingSize);
  const resolvedFat = payload.fat ?? payload.fats ?? 0;

  const food = await foodDatabaseService.createFood({
    createdByUser: userId,
    barcode: normalizeBarcode(payload.barcode),
    product: String(payload.foodName || '').trim(),
    brand: String(payload.brandName || '').trim(),
    servingSize: serving.servingSize,
    servingUnit: serving.servingUnit,
    calories: Number(payload.calories || 0),
    protein: Number(payload.protein || 0),
    carbs: Number(payload.carbs || 0),
    fat: Number(resolvedFat)
  });

  return mapFoodToCustomFood(food);
};

export const listCustomFoods = async ({ userId, search = '' }: ListCustomFoodParams): Promise<CustomFoodListItem[]> => {
  const normalizedSearch = String(search).trim();
  const query: Record<string, unknown> = { createdByUser: userId };

  if (normalizedSearch) {
    const regex = new RegExp(normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ product: regex }, { brand: regex }, { barcode: regex }];
  }

  const foods = await FoodDatabaseModel.find(query).sort({ createdAt: -1, _id: -1 });
  return foods.map(mapFoodToCustomFood);
};

export const scanFoodByBarcode = async (_userId: string, barcode: string): Promise<ScanBarcodeResponse> => {
  const normalizedBarcode = normalizeBarcode(barcode);
  if (!normalizedBarcode) {
    throw createHttpError('Barcode is required', 400);
  }

  const food = await FoodDatabaseModel.findOne({ barcode: normalizedBarcode }).sort({ createdAt: -1, _id: -1 });
  if (!food) {
    throw createHttpError('Food item not found for this barcode', 404);
  }

  return mapFoodToScanResponse(food);
};

export const scanMealWithAi = async (_userId: string, payload: ScanAiMealPayload): Promise<AiMealScanResponse> => {
  if (!process.env.OPENAI_API_KEY) {
    throw createHttpError('AI meal scanner is not configured. Missing OPENAI_API_KEY.', 500);
  }

  const imageUrl = resolveMealImageUrl(payload);
  const servingDescription = String(payload.servingDescription || 'the visible meal portion in the image').trim();

  const completion = await openai.chat.completions.create(
    {
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are Fitco AI Meal Scanner. Identify the meal from the image and estimate nutrition for the visible portion only. Return strict JSON with foodName, servingSize, confidence from 0 to 1, nutritionFacts.calories.value, nutritionFacts.protein.value, nutritionFacts.carbs.value, nutritionFacts.fats.value, and notes. Use kcal and grams. If uncertain, choose the most likely food name and provide a conservative estimate.'
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Estimate this meal for ${servingDescription}. Return only JSON.`
            },
            {
              type: 'image_url',
              image_url: {
                url: imageUrl,
                detail: 'low'
              }
            }
          ] as any
        }
      ]
    },
    {
      timeout: 30000
    }
  );

  const content = completion.choices[0]?.message?.content || '';
  return mapAiMealResponse(parseAiMealJson(content));
};

export const saveAiScannedMeal = async (userId: string, payload: SaveAiMealPayload): Promise<SavedAiMealResponse> => {
  if (!FOOD_LOG_MEALS.includes(payload.meal)) {
    throw createHttpError('Invalid meal value', 400);
  }

  const foodName = String(payload.foodName || '').trim();
  if (!foodName) {
    throw createHttpError('foodName is required', 400);
  }

  const imageUrl = await resolveImageBufferUpload(payload);
  const confidence = normalizeConfidence(payload.confidence);
  const notes = String(payload.notes || 'Estimated from the submitted meal image.').trim();
  const loggedAt = parseLoggedAt(payload.loggedAt);
  const { calories, protein, carbs, fat } = resolveAiNutritionValues(payload);

  const [user, customFood] = await Promise.all([
    UserModel.findById(userId),
    foodDatabaseService.createFood({
      createdByUser: userId,
      product: foodName,
      brand: 'AI Meal Scan',
      servingSize: 1,
      servingUnit: 'piece',
      calories,
      protein,
      carbs,
      fat
    })
  ]);

  const dailyGoal = getDailyGoalConfig(user);
  const macroBreakdown = getMacroBreakdown(protein, carbs, fat);
  const dailyGoals = getDailyGoalProgress(dailyGoal, calories, protein, carbs, fat);

  const foodLog = await FoodLogModel.create({
    user: userId,
    food: customFood._id,
    foodSource: 'custom',
    foodName,
    brandName: 'AI Meal Scan',
    imageUrl,
    meal: payload.meal,
    servings: 1,
    servingSize: 1,
    servingUnit: 'piece',
    baseServingSize: 1,
    baseServingUnit: 'piece',
    calories,
    protein,
    carbs,
    fat,
    macroBreakdown,
    dailyGoals,
    loggedAt
  });

  return buildAiMealResponse('AI scanned meal saved successfully', foodLog, {
    foodId: customFood._id.toString(),
    confidence,
    notes
  });
};

export const updateAiScannedMeal = async (
  userId: string,
  foodLogId: string,
  payload: Partial<SaveAiMealPayload>
): Promise<SavedAiMealResponse> => {
  const foodLog = await getAiMealFoodLog(userId, foodLogId);
  const linkedFood = await FoodDatabaseModel.findById(foodLog.food);

  if (!linkedFood) {
    throw createHttpError('Linked AI food record not found', 404);
  }

  const nextFoodName = payload.foodName !== undefined ? String(payload.foodName).trim() : foodLog.foodName;
  if (!nextFoodName) {
    throw createHttpError('foodName cannot be empty', 400);
  }

  const hasImageUpdate = payload.imageBase64 !== undefined || payload.imageUrl !== undefined;
  const nextImageUrl = hasImageUpdate ? await resolveImageBufferUpload(payload) : foodLog.imageUrl || '';
  const nextMeal = payload.meal ?? foodLog.meal;
  const nextLoggedAt = parseLoggedAtOrFallback(payload.loggedAt, foodLog.loggedAt);
  const nextNutrition = resolveAiNutritionValues({
    ...payload,
    nutritionFacts: payload.nutritionFacts,
    calories: payload.calories ?? foodLog.calories,
    protein: payload.protein ?? foodLog.protein,
    carbs: payload.carbs ?? foodLog.carbs,
    fats: payload.fats ?? payload.fat ?? foodLog.fat
  } as SaveAiMealPayload);

  const [user] = await Promise.all([
    UserModel.findById(userId),
    FoodDatabaseModel.findByIdAndUpdate(linkedFood._id, {
      product: nextFoodName,
      brand: 'AI Meal Scan',
      calories: nextNutrition.calories,
      protein: nextNutrition.protein,
      carbs: nextNutrition.carbs,
      fat: nextNutrition.fat
    })
  ]);

  const dailyGoal = getDailyGoalConfig(user);
  const macroBreakdown = getMacroBreakdown(nextNutrition.protein, nextNutrition.carbs, nextNutrition.fat);
  const dailyGoals = getDailyGoalProgress(
    dailyGoal,
    nextNutrition.calories,
    nextNutrition.protein,
    nextNutrition.carbs,
    nextNutrition.fat
  );

  foodLog.foodName = nextFoodName;
  foodLog.imageUrl = nextImageUrl;
  foodLog.meal = nextMeal;
  foodLog.calories = nextNutrition.calories;
  foodLog.protein = nextNutrition.protein;
  foodLog.carbs = nextNutrition.carbs;
  foodLog.fat = nextNutrition.fat;
  foodLog.macroBreakdown = macroBreakdown;
  foodLog.dailyGoals = dailyGoals;
  foodLog.loggedAt = nextLoggedAt;

  await foodLog.save();

  return buildAiMealResponse('AI scanned meal updated successfully', foodLog, {
    foodId: linkedFood._id.toString(),
    confidence: payload.confidence,
    notes: payload.notes
  });
};

export const deleteAiScannedMeal = async (userId: string, foodLogId: string): Promise<DeleteAiMealResponse> => {
  const foodLog = await getAiMealFoodLog(userId, foodLogId);
  const deletedSnapshot = {
    id: foodLog._id.toString(),
    meal: foodLog.meal,
    foodName: foodLog.foodName,
    imageUrl: foodLog.imageUrl || '',
    loggedAt: foodLog.loggedAt
  };
  const linkedFoodId = foodLog.food?.toString();

  await foodLog.deleteOne();

  if (linkedFoodId && mongoose.isValidObjectId(linkedFoodId)) {
    const remainingReferences = await FoodLogModel.countDocuments({ food: linkedFoodId });
    if (remainingReferences === 0) {
      await FoodDatabaseModel.findOneAndDelete({ _id: linkedFoodId, createdByUser: userId, brand: 'AI Meal Scan' });
    }
  }

  return {
    message: 'AI scanned meal deleted successfully',
    deletedFoodLog: deletedSnapshot
  };
};
