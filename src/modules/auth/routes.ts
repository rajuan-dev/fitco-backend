import { Router } from 'express';
import {
  adminLogin,
  appleLogin,
  changePassword,
  deleteAccount,
  forgotPassword,
  googleLogin,
  login,
  refresh,
  register,
  resetPassword,
  verifyRegister,
  verifyResetOtp
} from './controller';

const router = Router();

router.post('/register', register);
router.post('/verify-register', verifyRegister);
router.post('/login', login);
router.post('/google', googleLogin);
router.post('/apple', appleLogin);
router.post('/admin/login', adminLogin);
router.post('/refresh', refresh);
router.post('/forgot-password', forgotPassword);
router.post('/verify-reset-otp', verifyResetOtp);
router.post('/reset-password', resetPassword);
router.post('/change-password', changePassword);
router.delete('/delete-account', deleteAccount);

export default router;

