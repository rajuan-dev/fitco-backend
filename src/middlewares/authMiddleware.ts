import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import config from '../config';
import UserModel from '../modules/user/model';
import AdminModel from '../modules/admin/model';
import { Role, ROLES } from '../utils/constants';
import { TokenPayload } from '../utils/token';

const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        message: 'Authentication required',
        code: 'AUTH_REQUIRED',
        requestId: req.requestId
      });
    }

    const token = authHeader.replace('Bearer ', '');
    const decoded = jwt.verify(token, config.jwt.accessSecret) as TokenPayload & { exp: number };
    const account =
      decoded.role === ROLES.ADMIN
        ? await AdminModel.findById(decoded.sub)
        : await UserModel.findById(decoded.sub);

    if (!account) {
      return res.status(401).json({
        message: 'Account not found',
        code: 'ACCOUNT_NOT_FOUND',
        requestId: req.requestId
      });
    }

    if (decoded.role === 'user' && (account as any).isBlocked) {
      return res.status(403).json({
        message: 'Account is blocked',
        code: 'ACCOUNT_BLOCKED',
        requestId: req.requestId
      });
    }

    req.auth = {
      id: account._id.toString(),
      role: decoded.role,
      email: account.email,
      name: account.name || account.email
    };
    req.account = account;
    next();
  } catch (error) {
    return res.status(401).json({
      message: 'Invalid or expired token',
      code: 'AUTH_INVALID_TOKEN',
      requestId: req.requestId
    });
  }
};

const authorizeRoles = (...roles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    if (!req.auth || !roles.includes(req.auth.role as Role)) {
      return res.status(403).json({
        message: 'Forbidden',
        code: 'AUTH_FORBIDDEN',
        requestId: req.requestId
      });
    }
    next();
  };
};

export { authenticate, authorizeRoles };
