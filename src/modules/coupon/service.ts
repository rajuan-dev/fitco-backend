import CouponModel, { CouponDocument } from './model';
import { createHttpError } from '../../utils/httpError';

interface CouponPayload {
  code: string;
  discountPercentage: number;
  expiryDate: string;
  isActive?: boolean;
}

export const createCoupon = async (data: CouponPayload): Promise<CouponDocument> => {
  const payload = { ...data, code: data.code.toUpperCase(), discountPercentage: 20 };
  const existing = await CouponModel.findOne({ code: payload.code });
  if (existing) {
    throw createHttpError('A referral code with this value already exists.', 409, {
      code: 'COUPON_CODE_EXISTS',
    });
  }

  return CouponModel.create(payload);
};

export const updateCoupon = (id: string, data: Partial<CouponPayload>): Promise<CouponDocument | null> => {
  const payload = { ...data, discountPercentage: data.discountPercentage === undefined ? undefined : 20 };
  if (payload.code) {
    payload.code = payload.code.toUpperCase();
  }
  return (async () => {
    if (payload.code) {
      const existing = await CouponModel.findOne({ code: payload.code }).select('_id');
      if (existing && existing._id.toString() !== id) {
        throw createHttpError('A referral code with this value already exists.', 409, {
          code: 'COUPON_CODE_EXISTS',
        });
      }
    }
    return CouponModel.findByIdAndUpdate(id, payload, { new: true });
  })();
};

export const toggleCoupon = (id: string, isActive: boolean): Promise<CouponDocument | null> => {
  return CouponModel.findByIdAndUpdate(id, { isActive }, { new: true });
};

export const listCoupons = (): Promise<CouponDocument[]> => {
  return CouponModel.find().sort({ createdAt: -1 });
};

export const getCouponByCode = (code: string): Promise<CouponDocument | null> => {
  return CouponModel.findOne({ code: code.toUpperCase(), isActive: true, expiryDate: { $gt: new Date() } });
};

export const deleteCoupon = (id: string): Promise<void> => {
  return CouponModel.findByIdAndDelete(id).then(() => undefined);
};
