import mongoose from 'mongoose';
import connectDatabase from '../config/database';
import AuthTokenModel from '../modules/auth/model';
import ChatModel from '../modules/chat/model';
import CustomFoodModel from '../modules/customFood/model';
import FoodDatabaseModel from '../modules/foodDatabase/model';
import FoodLogModel from '../modules/foodLog/model';
import ReportModel from '../modules/report/model';
import SubscriptionModel from '../modules/subscription/model';
import TransactionModel from '../modules/subscription/transaction.model';
import UserModel from '../modules/user/model';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const parseArgs = (): { email: string; execute: boolean } => {
  const args = process.argv.slice(2);
  const emailArg = args.find(arg => !arg.startsWith('--'));
  const execute = args.includes('--execute');

  if (!emailArg) {
    throw new Error('Usage: ts-node src/seed/deleteUserByEmail.ts <email> [--execute]');
  }

  return {
    email: normalizeEmail(emailArg),
    execute
  };
};

const run = async (): Promise<void> => {
  const { email, execute } = parseArgs();
  await connectDatabase();

  const user = await UserModel.findOne({ email });
  if (!user) {
    console.log(JSON.stringify({ email, found: false }, null, 2));
    return;
  }

  const userId = user._id;
  const summary = {
    found: true,
    execute,
    user: {
      id: userId.toString(),
      email: user.email,
      name: user.name,
      role: user.role,
      isBlocked: user.isBlocked,
      subscriptionStatus: user.subscriptionStatus,
      stripeCustomerId: user.stripeCustomerId || null,
      createdAt: user.createdAt
    },
    related: {
      authTokens: await AuthTokenModel.countDocuments({ user: userId }),
      chats: await ChatModel.countDocuments({ user: userId }),
      customFoods: await CustomFoodModel.countDocuments({ user: userId }),
      foodLogs: await FoodLogModel.countDocuments({ user: userId }),
      customFoodDatabaseEntries: await FoodDatabaseModel.countDocuments({ createdByUser: userId }),
      reportsByUserField: await ReportModel.countDocuments({ user: userId }),
      reportsByContactEmail: await ReportModel.countDocuments({ contactEmail: email }),
      subscriptions: await SubscriptionModel.countDocuments({ user: userId }),
      transactions: await TransactionModel.countDocuments({ user: userId })
    }
  };

  if (!execute) {
    console.log(JSON.stringify(summary, null, 2));
    console.log('Dry run only. Re-run with --execute to delete this user and related records.');
    return;
  }

  const deletionResults = {
    authTokens: (await AuthTokenModel.deleteMany({ user: userId })).deletedCount,
    chats: (await ChatModel.deleteMany({ user: userId })).deletedCount,
    customFoods: (await CustomFoodModel.deleteMany({ user: userId })).deletedCount,
    foodLogs: (await FoodLogModel.deleteMany({ user: userId })).deletedCount,
    customFoodDatabaseEntries: (await FoodDatabaseModel.deleteMany({ createdByUser: userId })).deletedCount,
    reportsByUserField: (await ReportModel.deleteMany({ user: userId })).deletedCount,
    reportsByContactEmail: (await ReportModel.deleteMany({ contactEmail: email, user: { $ne: userId } })).deletedCount,
    subscriptions: (await SubscriptionModel.deleteMany({ user: userId })).deletedCount,
    transactions: (await TransactionModel.deleteMany({ user: userId })).deletedCount,
    users: (await UserModel.deleteOne({ _id: userId })).deletedCount
  };

  console.log(
    JSON.stringify(
      {
        ...summary,
        deleted: deletionResults
      },
      null,
      2
    )
  );
};

run()
  .catch(async error => {
    console.error('Failed to delete user by email', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
