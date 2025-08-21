const Zkteco = require('zkteco-js');
const Device = require('../models/Device');

class ZktecoService {
  constructor() {
    this.devices = new Map();
    
    // Restore connections from database on startup
    this.restoreConnections();
  }

  async restoreConnections() {
    try {
      const connectedDevices = await Device.find({ lastStatus: 'connected' });
      
      for (const device of connectedDevices) {
        try {
          await this.connect(
            device._id,
            device.ip,
            device.port,
            device.timeout,
            device.inactivity
          );

        } catch (error) {
          console.error(`Failed to restore connection to device ${device._id}:`, error);
          await Device.findByIdAndUpdate(device._id, {
            lastStatus: 'error'
          });
        }
      }
    } catch (error) {
      console.error('Error restoring connections:', error);
    }
  }

  async connect(deviceId, ip, port, timeout, inactivity) {
    try {
      const deviceKey = deviceId.toString();
      console.log(`Connecting to device: ${deviceKey}, IP: ${ip}, Port: ${port}`);
      
      // Check if device is already connected
      if (this.devices.has(deviceKey)) {
        const existingDevice = this.devices.get(deviceKey);
        if (existingDevice.isConnected) {
          console.log(`Device ${deviceKey} is already connected`);
          return { success: true, message: 'Device already connected' };
        }
      }

      // Create new connection
      const device = new Zkteco(ip, port, timeout, inactivity);
      await device.createSocket();
      
      // Store connection
      this.devices.set(deviceKey, {
        device,
        isConnected: true,
        ip,
        port
      });

      console.log(`Device ${deviceKey} connected successfully`);
      
      // Update device status in database
      await Device.findByIdAndUpdate(deviceId, {
        lastConnected: new Date(),
        lastStatus: 'connected'
      });

      return { success: true, message: 'Device connected successfully' };
    } catch (error) {
      console.error(`Connection failed for device ${deviceId}:`, error);
      
      // Update device status in database
      await Device.findByIdAndUpdate(deviceId, {
        lastStatus: 'error'
      });

      throw new Error(`Connection failed: ${error.message}`);
    }
  }

  async disconnect(deviceId) {
    try {
      const deviceKey = deviceId.toString();
      
      if (this.devices.has(deviceKey)) {
        const deviceObj = this.devices.get(deviceKey);
        if (deviceObj.isConnected) {
          await deviceObj.device.disconnect();
        }
        this.devices.delete(deviceKey);

        // Update device status in database
        await Device.findByIdAndUpdate(deviceId, {
          lastStatus: 'disconnected'
        });

        return { success: true, message: 'Device disconnected successfully' };
      }
      return { success: false, error: 'Device not found in active connections' };
    } catch (error) {
      throw new Error(`Disconnection failed: ${error.message}`);
    }
  }

  async getAttendances(deviceId) {
    try {
      const deviceKey = deviceId.toString();
      
      if (!this.devices.has(deviceKey) || !this.devices.get(deviceKey).isConnected) {
        throw new Error('Device not connected');
      }

      const deviceObj = this.devices.get(deviceKey);
      const logs = await deviceObj.device.getAttendances();
      
      return logs;
    } catch (error) {
      throw new Error(`Failed to get attendance: ${error.message}`);
    }
  }

  async getRealTimeLogs(deviceId, callback) {
    try {
      const deviceKey = deviceId.toString();
      
      if (!this.devices.has(deviceKey) || !this.devices.get(deviceKey).isConnected) {
        throw new Error('Device not connected');
      }

      const deviceObj = this.devices.get(deviceKey);
      await deviceObj.device.getRealTimeLogs(callback);
    } catch (error) {
      throw new Error(`Failed to get real-time logs: ${error.message}`);
    }
  }

  async getInfo(deviceId) {
    try {
      const deviceKey = deviceId.toString();
      
      // Check if device is in the map
      if (!this.devices.has(deviceKey)) {
        throw new Error('Device not connected');
      }
      
      let deviceObj = this.devices.get(deviceKey);
      
      // If not connected, try to reconnect
      if (!deviceObj.isConnected) {
        // You may need to fetch device info (ip, port, etc.) from DB
        const deviceData = await Device.findById(deviceId);
        if (!deviceData) {
          throw new Error('Device info not found in database');
        }
        
        const { ip, port, timeout = 5000, inactivity = 60000 } = deviceData;
        const device = new Zkteco(ip, port, timeout, inactivity);
        await device.createSocket();
        
        this.devices.set(deviceKey, {
          device,
          isConnected: true,
          ip,
          port
        });
        
        deviceObj = this.devices.get(deviceKey);
      }
      
      const info = await deviceObj.device.getInfo();
      return info;
    } catch (error) {
      throw new Error(`Failed to get device info: ${error.message}`);
    }
  }

  // Get all connected devices
  getConnectedDevices() {
    const connectedDevices = [];
    for (const [deviceKey, deviceObj] of this.devices) {
      if (deviceObj.isConnected) {
        connectedDevices.push(deviceKey);
      }
    }
    return connectedDevices;
  }

  // Check if a specific device is connected
  isDeviceConnected(deviceId) {
    const deviceKey = deviceId.toString();
    return this.devices.has(deviceKey) && this.devices.get(deviceKey).isConnected;
  }

  async getInfo(deviceId) {
  try {
    const deviceKey = deviceId.toString();
    console.log('Getting info for device:', deviceKey);
    console.log('Connected devices:', Array.from(this.devices.keys()));
    
    // Check if device is in the map
    if (!this.devices.has(deviceKey)) {
      console.log('Device not found in connected devices');
      throw new Error('Device not connected');
    }
    
    // Rest of the code...
  } catch (error) {
    console.error('Error in getInfo:', error);
    throw new Error(`Failed to get device info: ${error.message}`);
  }
}
}



module.exports = new ZktecoService();