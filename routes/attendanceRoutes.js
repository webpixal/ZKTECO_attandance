const express = require('express');
const router = express.Router();
const {
  getAttendance,
  getRealTimeAttendance,
  getAttendanceRecords
} = require('../controllers/attendanceController');

// Get attendance from device
router.get('/devices/:deviceId/attendance', getAttendance);
router.get('/devices/:deviceId/realtime', getRealTimeAttendance);

// Get attendance records from database
router.get('/devices/:deviceId/records', getAttendanceRecords);
router.get('/records', getAttendanceRecords); // Without device filter

module.exports = router;