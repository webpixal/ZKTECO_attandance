const mongoose = require('mongoose');

const deviceSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  ip: {
    type: String,
    required: true,
    match: /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
  },
  port: {
    type: Number,
    required: true,
    min: 1,
    max: 65535
  },
  timeout: {
    type: Number,
    default: 5200
  },
  inactivity: {
    type: Number,
    default: 5000
  },
  location: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastConnected: {
    type: Date
  },
  lastStatus: {
    type: String,
    enum: ['connected', 'disconnected', 'error'],
    default: 'disconnected'
  }
}, {
  timestamps: true
});

// Index for efficient querying
deviceSchema.index({ ip: 1, port: 1 }, { unique: true });

module.exports = mongoose.model('Device', deviceSchema);