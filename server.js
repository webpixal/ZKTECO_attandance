// server.js

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
const DEVICE_IP = '192.168.1.201';
const DEVICE_PORT = 4370;

let deviceInstance;
let usersCache = [];
let attendanceHistory = [];
let isDeviceConnected = false;

// Middleware and Routes
app.use(express.json());
app.use(express.static('public'));

// Helper function to ensure device is connected
async function ensureDeviceConnection() {
    if (isDeviceConnected && deviceInstance) {
        return true;
    }
    
    try {
        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, 10000);
        await deviceInstance.createSocket();
        isDeviceConnected = true;
        console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);
        return true;
    } catch (error) {
        console.error('Failed to connect to device:', error);
        isDeviceConnected = false;
        return false;
    }
}

// API route to get device information
app.get('/api/device-info', async (req, res) => {
    const connected = await ensureDeviceConnection();
    if (!connected) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        const deviceInfo = await deviceInstance.getInfo();
        res.status(200).json(deviceInfo);
    } catch (error) {
        console.error('Error fetching device info:', error);
        isDeviceConnected = false;
        res.status(500).json({ error: 'Failed to fetch device information' });
    }
});

// API route to get all users
app.get('/api/users', async (req, res) => {
    const connected = await ensureDeviceConnection();
    if (!connected) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        const users = await deviceInstance.getUsers();
        usersCache = users;
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        isDeviceConnected = false;
        res.status(500).json({ error: 'Failed to fetch users from device' });
    }
});

// API route to add a new user
app.post('/api/users', async (req, res) => {
    const connected = await ensureDeviceConnection();
    if (!connected) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        const { userId, name, cardNumber, role, password } = req.body;
        
        // Create user object based on device requirements
        const user = {
            userId: parseInt(userId),
            name: name,
            cardNumber: cardNumber || 0,
            role: role || 0,
            password: password || ""
        };
        
        const result = await deviceInstance.setUser(user);
        console.log('User added:', result);
        
        // Refresh users cache
        usersCache = await deviceInstance.getUsers();
        
        res.status(201).json({ message: 'User added successfully', user: user });
    } catch (error) {
        console.error('Error adding user:', error);
        isDeviceConnected = false;
        res.status(500).json({ error: 'Failed to add user to device' });
    }
});

// API route to update a user
app.put('/api/users/:userId', async (req, res) => {
    const connected = await ensureDeviceConnection();
    if (!connected) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        const userId = parseInt(req.params.userId);
        const { name, cardNumber, role, password } = req.body;
        
        // Find the user first
        const users = await deviceInstance.getUsers();
        const user = users.find(u => u.userId === userId);
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Update user properties
        if (name) user.name = name;
        if (cardNumber) user.cardNumber = cardNumber;
        if (role) user.role = role;
        if (password) user.password = password;
        
        const result = await deviceInstance.setUser(user);
        console.log('User updated:', result);
        
        // Refresh users cache
        usersCache = await deviceInstance.getUsers();
        
        res.status(200).json({ message: 'User updated successfully', user: user });
    } catch (error) {
        console.error('Error updating user:', error);
        isDeviceConnected = false;
        res.status(500).json({ error: 'Failed to update user on device' });
    }
});

// API route to delete a user
app.delete('/api/users/:userId', async (req, res) => {
    const connected = await ensureDeviceConnection();
    if (!connected) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        const userId = parseInt(req.params.userId);
        const result = await deviceInstance.deleteUser(userId);
        console.log('User deleted:', result);
        
        // Refresh users cache
        usersCache = await deviceInstance.getUsers();
        
        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        isDeviceConnected = false;
        res.status(500).json({ error: 'Failed to delete user from device' });
    }
});

// API route to get attendance history
app.get('/api/attendance', async (req, res) => {
    try {
        res.status(200).json(attendanceHistory);
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ error: 'Failed to fetch attendance data' });
    }
});

// Socket.IO for real-time updates
io.on('connection', async (socket) => {
    console.log('A web client connected');
    
    // Send current data to the newly connected client
    socket.emit('users_data', usersCache);
    socket.emit('attendance_history', attendanceHistory);
    
    // Send device info to the client if connected
    if (isDeviceConnected) {
        try {
            const info = await deviceInstance.getInfo();
            socket.emit('device_info', info);
        } catch (error) {
            console.error('Error getting device info:', error);
            isDeviceConnected = false;
        }
    }
});

// Function to process and broadcast attendance data
function processAndBroadcastAttendance(logData) {
    console.log('Raw attendance data:', logData);
    
    // Extract relevant information from the log data
    const attendanceRecord = {
        id: Date.now(),
        userId: logData.uid || logData.userId,
        timestamp: logData.timestamp || new Date(),
        verificationMethod: determineVerificationMethod(logData),
        punchType: determinePunchType(logData),
        deviceIp: DEVICE_IP,
        rawData: logData
    };
    
    // Try to find user details
    const user = usersCache.find(u => u.userId === attendanceRecord.userId);
    if (user) {
        attendanceRecord.userName = user.name;
        attendanceRecord.userCode = user.code;
    }
    
    console.log('Processed attendance record:', attendanceRecord);
    
    // Add to history (keep only last 1000 records)
    attendanceHistory.unshift(attendanceRecord);
    if (attendanceHistory.length > 1000) {
        attendanceHistory.pop();
    }
    
    // Broadcast to all connected clients
    io.emit('attendance_record', attendanceRecord);
    io.emit('attendance_history', attendanceHistory);
}

// Helper function to determine verification method
function determineVerificationMethod(logData) {
    if (logData.verificationType === 1) return 'Password';
    if (logData.verificationType === 2) return 'Fingerprint';
    if (logData.verificationType === 3) return 'Card';
    if (logData.verificationType === 4) return 'Face';
    if (logData.verificationType === 15) return 'Fingerprint or Password';
    return 'Unknown';
}

// Helper function to determine punch type
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
        isDeviceConnected = true;
        console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);

        // Get device info
        try {
            const deviceInfo = await deviceInstance.getInfo();
            console.log('Device Info:', deviceInfo);
        } catch (error) {
            console.error('Error getting device info:', error);
        }

        // Get users and cache them
        try {
            usersCache = await deviceInstance.getUsers();
            console.log('Total users on device:', usersCache.length);
        } catch (error) {
            console.error('Error getting users:', error);
        }

        // Set up real-time attendance monitoring
        try {
            await deviceInstance.getRealTimeLogs((realTimeLog) => {
                processAndBroadcastAttendance(realTimeLog);
            });
            console.log('Listening for real-time attendance data...');
        } catch (error) {
            console.error('Error setting up real-time logs:', error);
        }

    } catch (error) {
        console.error('Failed to connect to device:', error);
        isDeviceConnected = false;
        if (deviceInstance) {
            deviceInstance.disconnect();
        }
        setTimeout(initializeDevice, 5000);
    }
}

// Start Server
server.listen(EXPRESS_PORT, () => {
    console.log(`Server running on port ${EXPRESS_PORT}`);
    initializeDevice();
});