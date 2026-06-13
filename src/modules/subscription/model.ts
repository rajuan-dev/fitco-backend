import mongoose, { Document, Schema } from 'mongoose';
import { PLAN_TYPES, SUBSCRIPTION_STATUS, PlanType, SubscriptionStatus } from '../../utils/constants';

export interface SubscriptionDocument extends Document {
  user: mongoose.Types.ObjectId;
  platform: 'stripe' | 'apple' | 'google' | 'revenuecat';
  planType: PlanType;
  productId?: string;
  price: number;
  expiryDate: Date;
  status: SubscriptionStatus;
  isActive: boolean;
  couponCode?: string;
  transactionId?: string;
  purchaseToken?: string;
  providerSubscriptionId?: string;
  providerPayload?: Record<string, unknown>;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  stripeCheckoutSessionId?: string;
  startedAt: Date;
}

const SubscriptionSchema = new Schema<SubscriptionDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    platform: { type: String, enum: ['stripe', 'apple', 'google', 'revenuecat'], default: 'stripe', index: true },
    planType: { type: String, enum: Object.values(PLAN_TYPES), required: true },
    productId: { type: String, trim: true },
    price: { type: Number, required: true },
    expiryDate: { type: Date, required: true },
    status: { type: String, enum: Object.values(SUBSCRIPTION_STATUS), default: SUBSCRIPTION_STATUS.ACTIVE },
    isActive: { type: Boolean, default: true, index: true },
    couponCode: String,
    transactionId: { type: String, index: true, sparse: true },
    purchaseToken: { type: String, index: true, sparse: true },
    providerSubscriptionId: { type: String, index: true, sparse: true },
    providerPayload: { type: Object },
    stripeCustomerId: { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true, sparse: true },
    stripeCheckoutSessionId: String,
    startedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

SubscriptionSchema.index(
  { platform: 1, transactionId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      transactionId: { $exists: true, $type: 'string' }
    }
  }
);
SubscriptionSchema.index(
  { platform: 1, purchaseToken: 1 },
  {
    unique: true,
    partialFilterExpression: {
      purchaseToken: { $exists: true, $type: 'string' }
    }
  }
);

const SubscriptionModel = mongoose.model<SubscriptionDocument>('Subscription', SubscriptionSchema);

export default SubscriptionModel;
