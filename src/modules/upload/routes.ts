import { Router } from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/authMiddleware';
import { ROLES } from '../../utils/constants';
import { createUploadUrl, handleSingleFileUpload, uploadFile } from './controller';

const router = Router();

router.post(
  '/',
  authenticate,
  authorizeRoles(ROLES.USER, ROLES.ADMIN),
  handleSingleFileUpload,
  uploadFile
);

router.post(
  '/presigned-url',
  authenticate,
  authorizeRoles(ROLES.USER, ROLES.ADMIN),
  ...createUploadUrl
);

export default router;
