import { Router } from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/authMiddleware';
import { ROLES } from '../../utils/constants';
import { createCustomFood, listCustomFoods, scanFoodByBarcode, scanMealWithAi } from './controller';

const router = Router();

router.use(authenticate, authorizeRoles(ROLES.USER));
router.get('/', listCustomFoods);
router.post('/', createCustomFood);
router.post('/scan/ai', scanMealWithAi);
router.get('/scan/barcode/:barcode', scanFoodByBarcode);

export default router;
