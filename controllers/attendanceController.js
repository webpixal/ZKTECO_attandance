const Attendance = require('../models/Attendance');
const Device = require('../models/Device');
const zktecoService = require('../services/zktecoService');
// Get attendance logs from device
exports.getAttendance = async (req, res) => {
  try {
    const device = await Device.findById(req.params.deviceId);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const logs = await zktecoService.getAttendances(device._id);
    
    // Save to MongoDB
    const attendanceRecords = logs.map(log => ({
      userId: log.uid,
      timestamp: new Date(log.timestamp),
      status: log.status,
      device: device._id,
      verified: log.verified,
      type: log.type
    }));
    
    const savedLogs = await Attendance.insertMany(attendanceRecords);

    res.json({ success: true, logs: savedLogs });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get real-time attendance
exports.getRealTimeAttendance = async (req, res) => {
  try {
    const device = await Device.findById(req.params.deviceId);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    await zktecoService.getRealTimeLogs(device._id, async (log) => {
      // Save to MongoDB
      const attendanceRecord = new Attendance({
        userId: log.uid,
        timestamp: new Date(log.timestamp),
        status: log.status,
        device: device._id,
        verified: log.verified,
        type: log.type
      });
      
      await attendanceRecord.save();

      // Send the log via SSE or WebSocket would be better for production
      res.json({ success: true, log: attendanceRecord });
      
      // Disconnect after getting first log (as in original code)
      await zktecoService.disconnect(device._id);
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get attendance records from database
exports.getAttendanceRecords = async (req, res) => {
  try {
    const { page = 1, limit = 50, userId, startDate, endDate } = req.query;
    
    // Build filter object
    const filter = {};
    if (userId) filter.userId = userId;
    if (req.params.deviceId) filter.device = req.params.deviceId;
    
    // Date filter
    if (startDate || endDate) {
      filter.timestamp = {};
      if (startDate) filter.timestamp.$gte = new Date(startDate);
      if (endDate) filter.timestamp.$lte = new Date(endDate);
    }
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { timestamp: -1 },
      populate: 'device'
    };
    
    // Using mongoose-paginate-v2 would be better here
    const records = await Attendance.find(filter)
      .sort(options.sort)
      .limit(options.limit * 1)
      .skip((options.page - 1) * options.limit)
      .populate('device')
      .exec();
    
    const total = await Attendance.countDocuments(filter);
    
    res.json({
      success: true,
      records,
      totalPages: Math.ceil(total / options.limit),
      currentPage: options.page,
      total
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};