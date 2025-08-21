import { body, param, validationResult } from 'express-validator';

// Validation for device creation
const validateDevice = [
  body('name').notEmpty().withMessage('Name is required'),
  body('ip').isIP(4).withMessage('Valid IPv4 address is required'),
  body('port').isInt({ min: 1, max: 65535 }).withMessage('Valid port number is required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }
    next();
  }
];

// Validation for device ID parameter
const validateDeviceId = [
  param('id').isMongoId().withMessage('Valid device ID is required'),
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ 
        success: false, 
        errors: errors.array() 
      });
    }
    next();
  }
];

export default {
  validateDevice,
  validateDeviceId
};