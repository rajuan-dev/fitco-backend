import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcrypt';
import { ROLES } from '../../utils/constants';

export interface RefreshToken {
  token: string;
  expiresAt: Date;
}

export interface UserDocument extends Document {
  name: string;
  firstName?: string;
  lastName?: string;
  email: string;
  password: string;
  emailVerified: boolean;
  referralCode?: string;
  role: string;
  age?: number;
  height?: number;
  currentWeight?: number;
  weight?: number;
  targetWeight?: number;
  weeklyPace?: number;
  gender?: 'male' | 'female' | 'other';
  activityLevel?: 'standard' | 'sedentary' | 'lightly_active' | 'moderately_active' | 'very_active' | 'extremely_active';
  goal?: 'lose_weight' | 'maintain_weight' | 'gain_weight' | 'build_muscle';
  goals?: string;
  medicalConditions?: string;
  foodAllergies?: string;
  stripeCustomerId?: string;
  subscriptionStatus: 'free' | 'premium';
  dailyCalorieGoal?: number;
  dailyProteinGoal?: number;
  dailyCarbGoal?: number;
  dailyFatGoal?: number;
  dailyProteinPercent?: number;
  dailyCarbsPercent?: number;
  dailyFatPercent?: number;
  dailyGoalMode?: 'auto' | 'manual';
  isBlocked: boolean;
  refreshTokens: RefreshToken[];
  comparePassword(candidate: string): Promise<boolean>;
  createdAt: Date;
  updatedAt: Date;
}

const RefreshTokenSchema = new Schema<RefreshToken>(
  {
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  { _id: false }
);

const UserSchema = new Schema<UserDocument>(
  {
    name: { type: String, required: true, trim: true },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    emailVerified: { type: Boolean, default: false },
    referralCode: { type: String, trim: true, uppercase: true },
    role: { type: String, enum: [ROLES.ADMIN, ROLES.USER], default: ROLES.USER },
    age: Number,
    height: Number,
    currentWeight: Number,
    weight: Number,
    targetWeight: Number,
    weeklyPace: Number,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    activityLevel: {
      type: String,
      enum: ['standard', 'sedentary', 'lightly_active', 'moderately_active', 'very_active', 'extremely_active']
    },
    goal: { type: String, enum: ['lose_weight', 'maintain_weight', 'gain_weight', 'build_muscle'] },
    goals: String,
    medicalConditions: String,
    foodAllergies: String,
    stripeCustomerId: { type: String, index: true },
    subscriptionStatus: { type: String, enum: ['free', 'premium'], default: 'free' },
    dailyCalorieGoal: { type: Number, min: 1 },
    dailyProteinGoal: { type: Number, min: 0 },
    dailyCarbGoal: { type: Number, min: 0 },
    dailyFatGoal: { type: Number, min: 0 },
    dailyProteinPercent: { type: Number, min: 0, max: 100 },
    dailyCarbsPercent: { type: Number, min: 0, max: 100 },
    dailyFatPercent: { type: Number, min: 0, max: 100 },
    dailyGoalMode: { type: String, enum: ['auto', 'manual'], default: 'auto' },
    isBlocked: { type: Boolean, default: false },
    refreshTokens: [RefreshTokenSchema]
  },
  { timestamps: true }
);

UserSchema.pre<UserDocument>('save', async function () {
  if (!this.isModified('password')) {
    return;
  }
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.comparePassword = function (candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

const UserModel = mongoose.model<UserDocument>('User', UserSchema);

export default UserModel;
