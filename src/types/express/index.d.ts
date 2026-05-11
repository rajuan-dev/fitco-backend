import type { Document } from 'mongoose';
import type UserModel from '../../modules/user/model';
import type AdminModel from '../../modules/admin/model';

type UserDoc = Document & InstanceType<typeof UserModel>;
type AdminDoc = Document & InstanceType<typeof AdminModel>;

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      auth?: {
        id: string;
        role: string;
        email: string;
        name: string;
      };
      account?: UserDoc | AdminDoc;
    }
  }
}

export {};
