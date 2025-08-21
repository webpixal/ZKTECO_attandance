const Device = require('../models/Device');
const zktecoService = require('../services/zktecoService');

// Get all devices
exports.getDevices = async (req, res) => {
  try {
    const devices = await Device.find().sort({ createdAt: -1 });
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get a single device
exports.getDevice = async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }
    res.json({ success: true, device });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Create a new device
exports.createDevice = async (req, res) => {
  try {
    const device = new Device(req.body);
    await device.save();
    res.status(201).json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// Update a device
exports.updateDevice = async (req, res) => {
  try {
    const device = await Device.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }
    res.json({ success: true, device });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
};

// Delete a device
exports.deleteDevice = async (req, res) => {
  try {
    const device = await Device.findByIdAndDelete(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }
    
    // Disconnect if connected
    if (zktecoService.getConnectedDevices().includes(req.params.id)) {
      await zktecoService.disconnect(req.params.id);
    }
    
    res.json({ success: true, message: 'Device deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Connect to a device
exports.connectDevice = async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const result = await zktecoService.connect(
      device._id,
      device.ip,
      device.port,
      device.timeout,
      device.inactivity
    );
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Disconnect from a device
exports.disconnectDevice = async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    const result = await zktecoService.disconnect(device._id);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get device info
exports.getDeviceInfo = async (req, res) => {
  try {
    const device = await Device.findById(req.params.id);
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not found' });
    }

    // Use the service method to check if device is connected
    if (!zktecoService.isDeviceConnected(device._id)) {
      return res.status(400).json({ success: false, error: 'Device not connected' });
    }

    const info = await zktecoService.getInfo(device._id);
    res.json({ success: true, info });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};

// Get connected devices
exports.getConnectedDevices = async (req, res) => {
  try {
    const connectedDeviceIds = zktecoService.getConnectedDevices();
    const devices = await Device.find({ _id: { $in: connectedDeviceIds } });
    
    res.json({ success: true, devices });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};


exports.getAllConnectedDevices = async (req, res) => {
  try {
    const connectedDeviceIds = zktecoService.getConnectedDevices();
    const connectedDevices = [];
    
    for (const deviceId of connectedDeviceIds) {
      const device = await Device.findById(deviceId);
      if (device) {
        connectedDevices.push({
          id: device._id,
          name: device.name,
          ip: device.ip,
          port: device.port
        });
      }
    }
    
    res.json({ 
      success: true, 
      connectedDevices,
      internalMap: Array.from(zktecoService.devices.keys())
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
};