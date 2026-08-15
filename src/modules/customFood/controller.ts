import { NextFunction, Request, Response } from 'express';
import { body, param } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import validate from '../../middlewares/validationMiddleware';
import { getSingleQueryParam } from '../../utils/query';
import * as customFoodService from './service';
import { FOOD_LOG_MEALS } from '../foodLog/model';

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

const createCustomFoodValidators = [
  allowOnlyFields(['barcode', 'foodName', 'brandName', 'servingSize', 'calories', 'protein', 'carbs', 'fat', 'fats']),
  body('barcode').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('foodName').optional({ values: 'falsy' }).isString().trim(),
  body('brandName').optional({ values: 'falsy' }).isString().trim(),
  body('servingSize').optional({ values: 'falsy' }).isString().trim(),
  body('calories').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('protein').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('carbs').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fat').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fats').optional({ values: 'falsy' }).isFloat({ min: 0 })
];

const scanAiMealValidators = [
  allowOnlyFields(['imageBase64', 'imageUrl', 'mimeType', 'servingDescription']),
  body('imageBase64').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('imageUrl').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('mimeType').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('servingDescription').optional({ values: 'falsy' }).isString().trim(),
  body().custom((value) => {
    if (!value.imageBase64 && !value.imageUrl) {
      throw new Error('imageBase64 or imageUrl is required');
    }
    return true;
  })
];

const saveAiMealValidators = [
  allowOnlyFields([
    'meal',
    'imageBase64',
    'imageUrl',
    'mimeType',
    'foodName',
    'confidence',
    'nutritionFacts',
    'calories',
    'protein',
    'carbs',
    'fats',
    'fat',
    'notes',
    'loggedAt'
  ]),
  body('meal').isIn(FOOD_LOG_MEALS as unknown as string[]),
  body('imageBase64').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('imageUrl').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('mimeType').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('foodName').isString().trim().notEmpty(),
  body('confidence').optional({ values: 'falsy' }).isFloat({ min: 0, max: 1 }),
  body('nutritionFacts').optional().isObject(),
  body('nutritionFacts.calories.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.protein.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.carbs.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.fats.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('calories').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('protein').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('carbs').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fats').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fat').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('notes').optional({ values: 'falsy' }).isString().trim(),
  body('loggedAt').optional({ values: 'falsy' }).isISO8601(),
  body().custom((value) => {
    const hasNutritionFacts =
      value.nutritionFacts &&
      typeof value.nutritionFacts === 'object' &&
      (value.nutritionFacts.calories?.value !== undefined ||
        value.nutritionFacts.protein?.value !== undefined ||
        value.nutritionFacts.carbs?.value !== undefined ||
        value.nutritionFacts.fats?.value !== undefined);
    const hasFlatNutrition =
      value.calories !== undefined || value.protein !== undefined || value.carbs !== undefined || value.fats !== undefined || value.fat !== undefined;

    if (!hasNutritionFacts && !hasFlatNutrition) {
      throw new Error('Nutrition values are required');
    }

    if (!value.imageBase64 && !value.imageUrl) {
      throw new Error('imageBase64 or imageUrl is required');
    }

    return true;
  })
];

const aiMealLogIdValidators = [param('foodLogId').isMongoId()];

const aiMealUpdateFields = [
  'meal',
  'imageBase64',
  'imageUrl',
  'mimeType',
  'foodName',
  'confidence',
  'nutritionFacts',
  'calories',
  'protein',
  'carbs',
  'fats',
  'fat',
  'notes',
  'loggedAt'
];

const normalizeAiMealUpdateBody = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    next();
    return;
  }

  const normalizedBody: Record<string, unknown> = {};

  for (const field of aiMealUpdateFields) {
    if (req.body[field] !== undefined) {
      normalizedBody[field] = req.body[field];
    }
  }

  if (req.body.name !== undefined && normalizedBody.foodName === undefined) {
    normalizedBody.foodName = req.body.name;
  }

  req.body = normalizedBody;

  next();
};

const updateAiMealValidators = [
  ...aiMealLogIdValidators,
  allowOnlyFields(aiMealUpdateFields),
  body().custom((value) => {
    if (Object.keys(value).length === 0) {
      throw new Error('At least one field is required');
    }
    return true;
  }),
  body('meal').optional().isIn(FOOD_LOG_MEALS as unknown as string[]),
  body('imageBase64').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('imageUrl').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('mimeType').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('foodName').optional({ values: 'falsy' }).isString().trim().notEmpty(),
  body('confidence').optional({ values: 'falsy' }).isFloat({ min: 0, max: 1 }),
  body('nutritionFacts').optional().isObject(),
  body('nutritionFacts.calories.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.protein.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.carbs.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('nutritionFacts.fats.value').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('calories').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('protein').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('carbs').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fats').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('fat').optional({ values: 'falsy' }).isFloat({ min: 0 }),
  body('notes').optional({ values: 'falsy' }).isString().trim(),
  body('loggedAt').optional({ values: 'falsy' }).isISO8601()
];

const deleteAiMealValidators = [...aiMealLogIdValidators];

export const createCustomFood = [
  ...createCustomFoodValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const customFood = await customFoodService.createCustomFood(req.auth!.id, req.body);
    res.status(201).json(customFood);
  })
];

export const listCustomFoods = asyncHandler(async (req: Request, res: Response) => {
  const search = getSingleQueryParam(req.query.search) ?? '';
  const customFoods = await customFoodService.listCustomFoods({ userId: req.auth!.id, search });
  res.json(customFoods);
});

export const scanFoodByBarcode = asyncHandler(async (req: Request, res: Response) => {
  const result = await customFoodService.scanFoodByBarcode(req.auth!.id, req.params.barcode as string);
  res.json(result);
});

export const scanMealWithAi = [
  ...scanAiMealValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await customFoodService.scanMealWithAi(req.auth!.id, req.body);
    res.json(result);
  })
];

export const saveAiScannedMeal = [
  ...saveAiMealValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await customFoodService.saveAiScannedMeal(req.auth!.id, req.body);
    res.status(201).json(result);
  })
];

export const updateAiScannedMeal = [
  normalizeAiMealUpdateBody,
  ...updateAiMealValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await customFoodService.updateAiScannedMeal(req.auth!.id, req.params.foodLogId as string, req.body);
    res.json(result);
  })
];

export const deleteAiScannedMeal = [
  ...deleteAiMealValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const result = await customFoodService.deleteAiScannedMeal(req.auth!.id, req.params.foodLogId as string);
    res.json(result);
  })
];
