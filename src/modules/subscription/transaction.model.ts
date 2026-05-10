import mongoose, { Document, Schema } from 'mongoose';

export interface TransactionDocument extends Document {
  user: mongoose.Types.ObjectId;
  amount: number;
  planType: string;
  platform?: 'stripe' | 'apple' | 'google';
  status: 'paid' | 'failed';
  reference: string;
  couponCode?: string;
  currency?: string;
  productId?: string;
  stripeCheckoutSessionId?: string;
  stripeSubscriptionId?: string;
  stripeInvoiceId?: string;
  meta?: Record<string, unknown>;
}

const TransactionSchema = new Schema<TransactionDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true },
    planType: { type: String, required: true },
    platform: { type: String, enum: ['stripe', 'apple', 'google'], default: 'stripe', index: true },
    status: { type: String, enum: ['paid', 'failed'], default: 'paid' },
    reference: { type: String, required: true },
    couponCode: String,
    currency: String,
    productId: String,
    stripeCheckoutSessionId: { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true },
    stripeInvoiceId: { type: String, index: true },
    meta: { type: Object }
  },
  { timestamps: true }
);

const TransactionModel = mongoose.model<TransactionDocument>('Transaction', TransactionSchema);

export default TransactionModel;
