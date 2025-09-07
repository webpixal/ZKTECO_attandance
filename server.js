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

const EXPRESS_PORT = process.env.EXPRESS_PORT || 5500;
const DEVICE_IP = '192.168.159.201';
const DEVICE_PORT = 4370;

let deviceInstance;
let usersCache = [];

// Middleware and Routes
app.use(express.json());

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

// New endpoint to get recent attendance data
app.get('/api/attendance', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const attendance = await deviceInstance.getAttendances();
        res.status(200).json(attendance);
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ error: 'Failed to fetch attendance from device' });
    }
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
    console.log('A web client connected');
    socket.emit('users_data', usersCache);
});

// Function to process and broadcast attendance data
function processAndBroadcastAttendance(logData) {
    console.log('Raw attendance data:', logData);
    
    // Extract relevant information from the log data
    const attendanceRecord = {
        userId: logData.uid || logData.userId,
        timestamp: logData.timestamp || new Date(),
        verificationMethod: determineVerificationMethod(logData),
        punchType: determinePunchType(logData),
        deviceIp: DEVICE_IP,
        rawData: logData // Include raw data for debugging
    };
    
    // Try to find user details
    const user = usersCache.find(u => u.userId === attendanceRecord.userId);
    if (user) {
        attendanceRecord.userName = user.name;
        attendanceRecord.userCode = user.code;
    }
    
    console.log('Processed attendance record:', attendanceRecord);
    
    // Broadcast to all connected clients
    io.emit('attendance_record', attendanceRecord);
    
    // You could also save to a database here
    // saveToDatabase(attendanceRecord);
}

// Helper function to determine verification method
function determineVerificationMethod(logData) {
    // These values might vary based on your device model
    if (logData.verificationType === 1) return 'Password';
    if (logData.verificationType === 2) return 'Fingerprint';
    if (logData.verificationType === 3) return 'Card';
    if (logData.verificationType === 4) return 'Face';
    if (logData.verificationType === 15) return 'Fingerprint or Password';
    return 'Unknown';
}

// Helper function to determine punch type
function determinePunchType(logData) {
    // These values might vary based on your device model
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

        // Get users and cache them
        usersCache = await deviceInstance.getUsers();
        console.log('Total users on device:', usersCache.length);

        // Set up real-time attendance monitoring
        await deviceInstance.getRealTimeLogs((realTimeLog) => {
            // Process the attendance data immediately
            processAndBroadcastAttendance(realTimeLog);
        });

        console.log('Listening for real-time attendance data...');

    } catch (error) {
        console.error('Failed to connect to device:', error);
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