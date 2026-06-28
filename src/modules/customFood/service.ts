import FoodDatabaseModel, { FoodDatabaseDocument, FoodServingUnit } from '../foodDatabase/model';
import * as foodDatabaseService from '../foodDatabase/service';
import openai from '../../config/openai';

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

  const mimeType = String(payload.mimeType || 'image/jpeg').trim().toLowerCase();
  if (!SUPPORTED_IMAGE_MIME_TYPES.has(mimeType)) {
    throw createHttpError('mimeType must be image/jpeg, image/png, or image/webp', 400);
  }

  const normalizedBase64 = rawBase64.replace(/\s/g, '');
  if (!/^[a-z0-9+/]+={0,2}$/i.test(normalizedBase64)) {
    throw createHttpError('imageBase64 must be a valid base64 encoded image', 400);
  }

  return `data:${mimeType};base64,${normalizedBase64}`;
};

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
