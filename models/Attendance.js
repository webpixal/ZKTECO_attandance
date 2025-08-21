const mongoose = require('mongoose');

const attendanceSchema = new mongoose.Schema({
  userId: {
    type: Number,
    required: true
  },
  timestamp: {
    type: Date,
    required: true
  },
  status: {
    type: Number,
    required: true
  },
  device: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Device',
    required: true
  },
  verified: {
    type: Number,
    default: 0
  },
  type: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Compound index for efficient querying
attendanceSchema.index({ device: 1, timestamp: -1 });
attendanceSchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model('Attendance', attendanceSchema);