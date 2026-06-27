import { Request, Response } from 'express';
import { body } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import * as couponService from './service';
import validate from '../../middlewares/validationMiddleware';

const createValidators = [
  body('code').notEmpty(),
  body('discountPercentage')
    .custom((value) => Number(value) === 20)
    .withMessage('discountPercentage must be 20.'),
  body('expiryDate')
    .isISO8601()
    .custom((value) => {
      const expiry = new Date(value);
      if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
        throw new Error('expiryDate must be a future date-time');
      }
      return true;
    })
];

const updateValidators = [
  body('code').optional().notEmpty(),
  body('discountPercentage')
    .optional()
    .custom((value) => Number(value) === 20)
    .withMessage('discountPercentage must be 20.'),
  body('expiryDate')
    .optional()
    .isISO8601()
    .custom((value) => {
      const expiry = new Date(value);
      if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) {
        throw new Error('expiryDate must be a future date-time');
      }
      return true;
    })
];

export const createCoupon = [
  ...createValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const coupon = await couponService.createCoupon(req.body);
    res.status(201).json(coupon);
  })
];

export const updateCoupon = [
  ...updateValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const coupon = await couponService.updateCoupon(req.params.id as string, req.body);
    if (!coupon) {
      return res.status(404).json({ message: 'Coupon not found' });
    }
    res.json(coupon);
  })
];

export const toggleCoupon = asyncHandler(async (req: Request, res: Response) => {
  const { isActive } = req.body as { isActive?: boolean };
  if (typeof isActive !== 'boolean') {
    return res.status(400).json({ message: 'isActive flag is required' });
  }
  const coupon = await couponService.toggleCoupon(req.params.id as string, isActive);
  if (!coupon) {
    return res.status(404).json({ message: 'Coupon not found' });
  }
  res.json(coupon);
});

export const listCoupons = asyncHandler(async (req: Request, res: Response) => {
  const coupons = await couponService.listCoupons();
  res.json(coupons);
});

export const deleteCoupon = asyncHandler(async (req: Request, res: Response) => {
  await couponService.deleteCoupon(req.params.id as string);
  res.status(204).send();
});
