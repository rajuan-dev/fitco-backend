import mongoose, { Document, Schema } from 'mongoose';
import { FOOD_SERVING_UNITS, FoodServingUnit } from '../foodDatabase/model';

export const FOOD_LOG_MEALS = ['breakfast', 'lunch', 'dinner'] as const;
export type FoodLogMeal = (typeof FOOD_LOG_MEALS)[number];
export const FOOD_LOG_SOURCES = ['database', 'custom'] as const;
export type FoodLogSource = (typeof FOOD_LOG_SOURCES)[number];

interface MacroBreakdown {
  grams: number;
  percentage: number;
}

interface DailyGoalProgress {
  value: number;
  target: number;
  percentage: number;
}

interface MacroBreakdownMap {
  protein: MacroBreakdown;
  carbs: MacroBreakdown;
  fat: MacroBreakdown;
}

interface DailyGoalProgressMap {
  calories: DailyGoalProgress;
  protein: DailyGoalProgress;
  carbs: DailyGoalProgress;
  fat: DailyGoalProgress;
}

export interface FoodLogDocument extends Document {
  user: mongoose.Types.ObjectId;
  food: mongoose.Types.ObjectId;
  foodSource: FoodLogSource;
  foodName: string;
  brandName?: string;
  imageUrl?: string;
  meal: FoodLogMeal;
  servings: number;
  servingSize: number;
  servingUnit: FoodServingUnit;
  baseServingSize: number;
  baseServingUnit: FoodServingUnit;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  macroBreakdown: MacroBreakdownMap;
  dailyGoals: DailyGoalProgressMap;
  loggedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const MacroBreakdownSchema = new Schema<MacroBreakdown>(
  {
    grams: { type: Number, required: true, min: 0 },
    percentage: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const DailyGoalProgressSchema = new Schema<DailyGoalProgress>(
  {
    value: { type: Number, required: true, min: 0 },
    target: { type: Number, required: true, min: 0 },
    percentage: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const FoodLogSchema = new Schema<FoodLogDocument>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    food: { type: Schema.Types.ObjectId, ref: 'FoodDatabase', required: true, index: true },
    foodSource: { type: String, enum: FOOD_LOG_SOURCES, required: true, default: 'database', index: true },
    foodName: { type: String, required: true, trim: true },
    brandName: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, default: '' },
    meal: { type: String, enum: FOOD_LOG_MEALS, required: true },
    servings: { type: Number, required: true, min: 0.01 },
    servingSize: { type: Number, required: true, min: 0.01 },
    servingUnit: { type: String, enum: FOOD_SERVING_UNITS, required: true },
    baseServingSize: { type: Number, required: true, min: 0.01 },
    baseServingUnit: { type: String, enum: FOOD_SERVING_UNITS, required: true },
    calories: { type: Number, required: true, min: 0 },
    protein: { type: Number, required: true, min: 0 },
    carbs: { type: Number, required: true, min: 0 },
    fat: { type: Number, required: true, min: 0 },
    macroBreakdown: {
      protein: { type: MacroBreakdownSchema, required: true },
      carbs: { type: MacroBreakdownSchema, required: true },
      fat: { type: MacroBreakdownSchema, required: true }
    },
    dailyGoals: {
      calories: { type: DailyGoalProgressSchema, required: true },
      protein: { type: DailyGoalProgressSchema, required: true },
      carbs: { type: DailyGoalProgressSchema, required: true },
      fat: { type: DailyGoalProgressSchema, required: true }
    },
    loggedAt: { type: Date, required: true, default: Date.now, index: true }
  },
  { timestamps: true }
);

FoodLogSchema.index({ user: 1, loggedAt: -1 });
FoodLogSchema.index({ user: 1, meal: 1, loggedAt: -1 });

const FoodLogModel = mongoose.model<FoodLogDocument>('FoodLog', FoodLogSchema);

export default FoodLogModel;
