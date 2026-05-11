import { Request, Response } from 'express';
import { body } from 'express-validator';
import asyncHandler from '../../utils/asyncHandler';
import * as chatService from './service';
import validate from '../../middlewares/validationMiddleware';

const messageValidators = [body('message').isString().trim().isLength({ min: 1 })];

export const sendMessage = [
  ...messageValidators,
  validate,
  asyncHandler(async (req: Request, res: Response) => {
    const { answer } = await chatService.sendMessage(req.auth!.id, req.body.message);
    res.json({ message: answer });
  })
];

export const getHistory = asyncHandler(async (req: Request, res: Response) => {
  const history = await chatService.getHistory(req.auth!.id);
  res.json(history);
});

export const getMyChatLimit = asyncHandler(async (req: Request, res: Response) => {
  const limit = await chatService.getChatLimitStatus(req.auth!.id);
  res.json(limit);
});
