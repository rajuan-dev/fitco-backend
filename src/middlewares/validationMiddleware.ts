import { NextFunction, Request, Response } from 'express';
import { validationResult } from 'express-validator';

const validate = (req: Request, res: Response, next: NextFunction): Response | void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const validationErrors = errors.array();
    return res.status(422).json({
      message: validationErrors[0]?.msg || 'Validation failed',
      errors: validationErrors
    });
  }
  next();
};

export default validate;
