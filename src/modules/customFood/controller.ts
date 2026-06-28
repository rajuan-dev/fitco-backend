import { Request, Response } from 'express';
import { body } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import validate from '../../middlewares/validationMiddleware';
import { getSingleQueryParam } from '../../utils/query';
import * as customFoodService from './service';

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
