const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Zkteco = require('zkteco-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const EXPRESS_PORT = process.env.EXPRESS_PORT || 5500;
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

// API Routes
app.get('/api/device-info', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    res.status(200).json(deviceInfo);
  } catch (error) {
    console.error('Error fetching device info:', error);
    res.status(500).json({ error: 'Failed to fetch device information' });
  }
});

app.get('/api/users', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    res.status(200).json(usersCache);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users from device' });
  }
});

app.post('/api/users', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const { userId, name, cardNumber, role, password } = req.body;
    
    // Create user object
    const user = {
      uid: parseInt(userId),
      name: name,
      cardno: cardNumber || 0,
      role: role || 0,
      password: password || ""
    };
    
    // Add user to device
    const result = await deviceInstance.setUser(user);
    console.log('User added:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(201).json({ message: 'User added successfully', user: user });
  } catch (error) {
    console.error('Error adding user:', error);
    res.status(500).json({ error: 'Failed to add user to device' });
  }
});

app.put('/api/users/:userId', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const userId = parseInt(req.params.userId);
    const { name, cardNumber, role, password } = req.body;
    
    // Find the user
    const user = usersCache.find(u => u.uid === userId);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user properties
    if (name) user.name = name;
    if (cardNumber) user.cardno = cardNumber;
    if (role) user.role = role;
    if (password) user.password = password;
    
    // Update user on device
    const result = await deviceInstance.setUser(user);
    console.log('User updated:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(200).json({ message: 'User updated successfully', user: user });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user on device' });
  }
});

app.delete('/api/users/:userId', async (req, res) => {
  if (!deviceInstance) {
    return res.status(503).json({ error: 'Device not connected' });
  }
  try {
    const userId = parseInt(req.params.userId);
    
    // Delete user from device
    const result = await deviceInstance.deleteUser(userId);
    console.log('User deleted:', result);
    
    // Refresh users cache
    usersCache = await deviceInstance.getUsers();
    
    res.status(200).json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user from device' });
  }
});

app.get('/api/attendance', async (req, res) => {
  try {
    res.status(200).json(attendanceHistory);
  } catch (error) {
    console.error('Error fetching attendance:', error);
    res.status(500).json({ error: 'Failed to fetch attendance data' });
  }
});

// Clear attendance data
app.delete('/api/attendance', async (req, res) => {
  try {
    if (deviceInstance) {
      await deviceInstance.clearAttendanceLog();
      attendanceHistory = [];
      res.status(200).json({ message: 'Attendance data cleared successfully' });
    } else {
      res.status(503).json({ error: 'Device not connected' });
    }
  } catch (error) {
    console.error('Error clearing attendance:', error);
    res.status(500).json({ error: 'Failed to clear attendance data' });
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

    // Set up real-time attendance monitoring
    await deviceInstance.getRealTimeLogs((realTimeLog) => {
      processAndBroadcastAttendance(realTimeLog);
    });

    console.log('Listening for real-time attendance data...');
    
    // Update all connected clients
    io.emit('device_connected', true);
    io.emit('device_info', deviceInfo);
    io.emit('users_data', usersCache);

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