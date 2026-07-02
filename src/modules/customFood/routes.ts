import { Router } from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/authMiddleware';
import { ROLES } from '../../utils/constants';
import {
  createCustomFood,
  deleteAiScannedMeal,
  listCustomFoods,
  saveAiScannedMeal,
  scanFoodByBarcode,
  scanMealWithAi,
  updateAiScannedMeal
} from './controller';

const router = Router();

router.use(authenticate, authorizeRoles(ROLES.USER));
router.get('/', listCustomFoods);
router.post('/', createCustomFood);
router.post('/scan/ai', scanMealWithAi);
router.post('/scan/ai/save', saveAiScannedMeal);
router.patch('/scan/ai/:foodLogId', updateAiScannedMeal);
router.delete('/scan/ai/:foodLogId', deleteAiScannedMeal);
router.get('/scan/barcode/:barcode', scanFoodByBarcode);

export default router;
