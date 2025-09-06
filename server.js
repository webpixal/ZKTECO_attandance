const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const EXPRESS_PORT = process.env.EXPRESS_PORT || 5500;
const DEVICE_IP = process.env.DEVICE_IP || '192.168.159.201';
const ZKTECO_API_BASE = process.env.ZKTECO_API_BASE || 'http://time.xmzkteco.com:8097/api/terminal';

let usersCache = [];
let attendanceHistory = [];
let deviceInfo = {};

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Helper to call official ZKTeco API
async function callZKTecoAPI(endpoint, data = {}) {
  const url = `${ZKTECO_API_BASE}/${endpoint}`;
  try {
    // Add device IP to all requests
    const requestData = { ip: DEVICE_IP, ...data };
    
    const response = await axios.post(url, requestData, {
      headers: { 'Content-Type': 'application/json' }
    });
    
    return response.data;
  } catch (error) {
    console.error(`API Error (${endpoint}):`, error.response?.data || error.message);
    throw error.response?.data || error;
  }
}

// API to get device information
app.get('/api/device-info', async (req, res) => {
  try {
    const info = await callZKTecoAPI('getDeviceInfo');
    deviceInfo = info;
    io.emit('device_info', info);
    res.status(200).json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch device information', details: error });
  }
});

// API to get all users
app.get('/api/users', async (req, res) => {
  try {
    const users = await callZKTecoAPI('getUserList');
    usersCache = users.data || [];
    io.emit('users_data', usersCache);
    res.status(200).json(usersCache);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch users', details: error });
  }
});

// API to add a new user
app.post('/api/users', async (req, res) => {
  try {
    const result = await callZKTecoAPI('addUser', req.body);
    io.emit('user_added', result);
    
    // Refresh users list
    const users = await callZKTecoAPI('getUserList');
    usersCache = users.data || [];
    io.emit('users_data', usersCache);
    
    res.status(201).json({ message: 'User added successfully', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to add user', details: error });
  }
});

// API to update a user
app.put('/api/users/:uid', async (req, res) => {
  try {
    const result = await callZKTecoAPI('updateUser', { uid: req.params.uid, ...req.body });
    io.emit('user_updated', result);
    
    // Refresh users list
    const users = await callZKTecoAPI('getUserList');
    usersCache = users.data || [];
    io.emit('users_data', usersCache);
    
    res.status(200).json({ message: 'User updated successfully', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user', details: error });
  }
});

// API to delete a user
app.delete('/api/users/:uid', async (req, res) => {
  try {
    const result = await callZKTecoAPI('deleteUser', { uid: req.params.uid });
    io.emit('user_deleted', result);
    
    // Refresh users list
    const users = await callZKTecoAPI('getUserList');
    usersCache = users.data || [];
    io.emit('users_data', usersCache);
    
    res.status(200).json({ message: 'User deleted successfully', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete user', details: error });
  }
});

// API to get attendance logs
app.get('/api/attendance', async (req, res) => {
  try {
    const attendance = await callZKTecoAPI('getAttendanceLog');
    attendanceHistory = attendance.data || [];
    io.emit('attendance_history', attendanceHistory);
    res.status(200).json(attendanceHistory);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch attendance', details: error });
  }
});

// API to clear attendance logs
app.delete('/api/attendance', async (req, res) => {
  try {
    const result = await callZKTecoAPI('clearAttendanceLog');
    attendanceHistory = [];
    io.emit('attendance_history', attendanceHistory);
    res.status(200).json({ message: 'Attendance logs cleared successfully', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear attendance logs', details: error });
  }
});

// API to get device time
app.get('/api/device-time', async (req, res) => {
  try {
    const time = await callZKTecoAPI('getDeviceTime');
    res.status(200).json({ deviceTime: time.data });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch device time', details: error });
  }
});

// API to set device time
app.post('/api/device-time', async (req, res) => {
  try {
    const { dateTime } = req.body;
    if (!dateTime) return res.status(400).json({ error: 'DateTime is required' });
    
    const result = await callZKTecoAPI('setDeviceTime', { dateTime });
    res.status(200).json({ message: 'Device time updated successfully', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to set device time', details: error });
  }
});

// API to run voice test
app.post('/api/voice-test', async (req, res) => {
  try {
    const result = await callZKTecoAPI('voiceTest');
    res.status(200).json({ message: 'Voice test executed', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run voice test', details: error });
  }
});

// API to clear all data
app.delete('/api/clear-data', async (req, res) => {
  try {
    const result = await callZKTecoAPI('clearData');
    usersCache = [];
    attendanceHistory = [];
    io.emit('users_data', usersCache);
    io.emit('attendance_history', attendanceHistory);
    res.status(200).json({ message: 'All data cleared from device', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear device data', details: error });
  }
});

// API to get transactions with filters
app.get('/api/transactions', async (req, res) => {
  try {
    const { startDate, endDate, userId } = req.query;
    const data = {};
    
    if (startDate) data.startDate = startDate;
    if (endDate) data.endDate = endDate;
    if (userId) data.userId = userId;

    const transactions = await callZKTecoAPI('getTransaction', data);
    io.emit('transactions_data', transactions.data || []);
    res.status(200).json(transactions.data || []);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch transactions', details: error });
  }
});

// API to get current device IP
app.get('/api/device-ip', (req, res) => {
  res.status(200).json({ ip: DEVICE_IP });
});

// API to update device IP
app.post('/api/device-ip', (req, res) => {
  // Note: This only changes the IP in the server memory, not the actual device
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'IP address is required' });
  
  // In a real scenario, you would need to update the device's IP through its admin interface
  // This just changes what IP the server will communicate with
  DEVICE_IP = ip;
  io.emit('device_ip', DEVICE_IP);
  res.status(200).json({ message: 'Device IP updated in server configuration', ip: DEVICE_IP });
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('A web client connected');
  socket.emit('users_data', usersCache);
  socket.emit('attendance_history', attendanceHistory);
  socket.emit('device_info', deviceInfo);
  socket.emit('device_ip', DEVICE_IP);
});

// Start Server
server.listen(EXPRESS_PORT, () => {
  console.log(`Server running on port ${EXPRESS_PORT}`);
  console.log(`ZKTeco API Base: ${ZKTECO_API_BASE}`);
  console.log(`Device IP: ${DEVICE_IP}`);
  
  // Initialize data on server start
  initializeData();
});

async function initializeData() {
  try {
    // Get device info
    const info = await callZKTecoAPI('getDeviceInfo');
    deviceInfo = info;
    io.emit('device_info', info);
    
    // Get users
    const users = await callZKTecoAPI('getUserList');
    usersCache = users.data || [];
    io.emit('users_data', usersCache);
    
    // Get attendance
    const attendance = await callZKTecoAPI('getAttendanceLog');
    attendanceHistory = attendance.data || [];
    io.emit('attendance_history', attendanceHistory);
    
    console.log('Initial data loaded successfully');
  } catch (error) {
    console.error('Failed to initialize data:', error);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Shutting down server...');
  process.exit(0);
});