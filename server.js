const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Zkteco = require('zkteco-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const EXPRESS_PORT = process.env.EXPRESS_PORT || 3000;
let DEVICE_IP = process.env.DEVICE_IP || '192.168.1.201';
const DEVICE_PORT = process.env.DEVICE_PORT || 4370;

let deviceInstance;
let usersCache = [];
let attendanceHistory = [];
let deviceInfo = {};

// Middleware
app.use(express.json());
app.use(express.static('public'));

// API to update device IP
app.post('/api/device-ip', (req, res) => {
  const { ip } = req.body;
  if (!ip) {
    return res.status(400).json({ error: 'IP address is required' });
  }
  
  DEVICE_IP = ip;
  console.log(`Device IP updated to: ${DEVICE_IP}`);
  
  // Reinitialize device connection with new IP
  if (deviceInstance) {
    deviceInstance.disconnect();
  }
  initializeDevice();
  
  res.status(200).json({ message: 'Device IP updated successfully', ip: DEVICE_IP });
});

// API to get current device IP
app.get('/api/device-ip', (req, res) => {
  res.status(200).json({ ip: DEVICE_IP });
});

// API to get device information
app.get('/api/device-info', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const info = {
      deviceName: await deviceInstance.getDeviceName(),
      platform: await deviceInstance.getPlatform(),
      firmwareVersion: await deviceInstance.getDeviceVersion(),
      macAddress: await deviceInstance.getMacAddress(),
      vendor: await deviceInstance.getVendor(),
      productTime: await deviceInstance.getProductTime(),
      logCapacity: deviceInfo.logCapacity,
      userCount: deviceInfo.userCount,
      attendanceSize: await deviceInstance.getAttendanceSize(),
      faceOn: await deviceInstance.getFaceOn(),
      ssr: await deviceInstance.getSSR(),
      pin: await deviceInstance.getPIN(),
      deviceTime: await deviceInstance.getTime()
    };
    
    res.status(200).json(info);
  } catch (error) {
    console.error('Error fetching device info:', error);
    res.status(500).json({ error: 'Failed to fetch device information' });
  }
});

// API to get all users
app.get('/api/users', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const users = await deviceInstance.getUsers();
    usersCache = users;
    res.status(200).json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users from device' });
  }
});

// API to add a new user
app.post('/api/users', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const { uid, userid, name, password, role, cardno } = req.body;
    
    // Add user to device using the correct method signature
    const result = await deviceInstance.setUser(uid, userid, name, password, role || 0, cardno || 0);
    console.log('User added:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(201).json({ message: 'User added successfully', result });
  } catch (error) {
    console.error('Error adding user:', error);
    res.status(500).json({ error: 'Failed to add user to device' });
  }
});

// API to update a user
app.put('/api/users/:uid', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const uid = parseInt(req.params.uid);
    const { userid, name, password, role, cardno } = req.body;
    
    // Update user on device
    const result = await deviceInstance.setUser(uid, userid, name, password, role || 0, cardno || 0);
    console.log('User updated:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(200).json({ message: 'User updated successfully', result });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user on device' });
  }
});

// API to delete a user
app.delete('/api/users/:uid', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const uid = parseInt(req.params.uid);
    
    // Delete user from device
    const result = await deviceInstance.deleteUser(uid);
    console.log('User deleted:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(200).json({ message: 'User deleted successfully', result });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user from device' });
  }
});

// API to get attendance logs
app.get('/api/attendance', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const attendance = await deviceInstance.getAttendances();
    attendanceHistory = attendance;
    res.status(200).json(attendance);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance from device' });
  }
});

// API to clear attendance logs
app.delete('/api/attendance', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const result = await deviceInstance.clearAttendanceLog();
    attendanceHistory = [];
    res.status(200).json({ message: 'Attendance logs cleared successfully', result });
  } catch (error) {
    console.error('Error clearing attendance:', error);
    res.status(500).json({ error: 'Failed to clear attendance logs' });
  }
});

// API to get device time
app.get('/api/device-time', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const time = await deviceInstance.getTime();
    res.status(200).json({ deviceTime: time });
  } catch (error) {
    console.error('Error fetching device time:', error);
    res.status(500).json({ error: 'Failed to fetch device time' });
  }
});

// API to set device time
app.post('/api/device-time', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const { dateTime } = req.body;
    if (!dateTime) {
      return res.status(400).json({ error: 'DateTime is required' });
    }
    
    const result = await deviceInstance.setTime(new Date(dateTime));
    res.status(200).json({ message: 'Device time updated successfully', result });
  } catch (error) {
    console.error('Error setting device time:', error);
    res.status(500).json({ error: 'Failed to set device time' });
  }
});

// API to run voice test
app.post('/api/voice-test', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const result = await deviceInstance.voiceTest();
    res.status(200).json({ message: 'Voice test executed', result });
  } catch (error) {
    console.error('Error running voice test:', error);
    res.status(500).json({ error: 'Failed to run voice test' });
  }
});

// API to clear all data
app.delete('/api/clear-data', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const result = await deviceInstance.clearData();
    usersCache = [];
    attendanceHistory = [];
    res.status(200).json({ message: 'All data cleared from device', result });
  } catch (error) {
    console.error('Error clearing device data:', error);
    res.status(500).json({ error: 'Failed to clear device data' });
  }
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('A web client connected');
  socket.emit('users_data', usersCache);
  socket.emit('attendance_history', attendanceHistory);
  socket.emit('device_info', deviceInfo);
  socket.emit('device_ip', DEVICE_IP);
});

// Process and broadcast attendance data
function processAndBroadcastAttendance(logData) {
  const attendanceRecord = {
    id: Date.now(),
    userId: logData.uid,
    timestamp: logData.timestamp || new Date(),
    verificationMethod: determineVerificationMethod(logData),
    punchType: determinePunchType(logData),
    deviceIp: DEVICE_IP
  };
  
  // Find user details
  const user = usersCache.find(u => u.uid === attendanceRecord.userId);
  if (user) {
    attendanceRecord.userName = user.name;
    attendanceRecord.userCode = user.userid;
  }
  
  // Add to history (keep only last 1000 records)
  attendanceHistory.unshift(attendanceRecord);
  if (attendanceHistory.length > 1000) {
    attendanceHistory.pop();
  }
  
  // Broadcast to all connected clients
  io.emit('attendance_record', attendanceRecord);
  io.emit('attendance_history', attendanceHistory);
}

// Helper functions
function determineVerificationMethod(logData) {
  if (logData.verificationType === 1) return 'Password';
  if (logData.verificationType === 2) return 'Fingerprint';
  if (logData.verificationType === 3) return 'Card';
  if (logData.verificationType === 4) return 'Face';
  if (logData.verificationType === 15) return 'Fingerprint or Password';
  return 'Unknown';
}

function determinePunchType(logData) {
  if (logData.status === 0) return 'Check-in';
  if (logData.status === 1) return 'Check-out';
  if (logData.status === 2) return 'Break-out';
  if (logData.status === 3) return 'Break-in';
  if (logData.status === 4) return 'Overtime-in';
  if (logData.status === 5) return 'Overtime-out';
  return 'Unknown';
}

// Initialize Device Connection
async function initializeDevice() {
  try {
    deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, 10000);
    await deviceInstance.createSocket();
    console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);

    // Get device info
    deviceInfo = await deviceInstance.getInfo();
    console.log('Device Info:', deviceInfo);

    // Get users and cache them
    usersCache = await deviceInstance.getUsers();
    console.log('Total users on device:', usersCache.length);

    // Get attendance logs
    attendanceHistory = await deviceInstance.getAttendances();
    console.log('Total attendance records:', attendanceHistory.length);

    // Set up real-time attendance monitoring
    await deviceInstance.getRealTimeLogs((realTimeLog) => {
      processAndBroadcastAttendance(realTimeLog);
    });

    console.log('Listening for real-time attendance data...');
    
    // Update all connected clients
    io.emit('device_connected', true);
    io.emit('device_info', deviceInfo);
    io.emit('users_data', usersCache);
    io.emit('attendance_history', attendanceHistory);

  } catch (error) {
    console.error('Failed to connect to device:', error);
    if (deviceInstance) {
      deviceInstance.disconnect();
    }
    io.emit('device_connected', false);
    // Attempt to reconnect after a delay
    setTimeout(initializeDevice, 5000);
  }
}

// Start Server
server.listen(EXPRESS_PORT, () => {
  console.log(`Server running on port ${EXPRESS_PORT}`);
  initializeDevice();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  if (deviceInstance) {
    await deviceInstance.disconnect();
  }
  process.exit(0);
});