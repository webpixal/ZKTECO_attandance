const express = require('express');
const router = express.Router();
const {
  getDevices,
  getDevice,
  createDevice,
  updateDevice,
  deleteDevice,
  connectDevice,
  disconnectDevice,
  getDeviceInfo,
  getConnectedDevices,
  getAllConnectedDevices
} = require('../controllers/deviceController');

// Device management routes
router.get('/', getDevices);
router.get('/connected', getConnectedDevices);
router.get('/:id', getDevice);
router.post('/', createDevice);
router.put('/:id', updateDevice);
router.delete('/:id', deleteDevice);

// Device connection routes
router.post('/:id/connect', connectDevice);
router.post('/:id/disconnect', disconnectDevice);
router.get('/:id/info', getDeviceInfo);
router.get('/debug/connected', getAllConnectedDevices);

module.exports = router;