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
const DEVICE_IP = '113.11.48.159';
const DEVICE_PORT = 4370;

let deviceInstance;
let usersCache = []; // Cache to store user data

// Middleware and Routes
app.use(express.json());

app.get('/api/users', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const users = await deviceInstance.getUsers();
        usersCache = users; // Update cache
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users from device' });
    }
});

// New endpoint to get attendance logs
app.get('/api/attendance', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        // This might vary based on your device model and library
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
    
    // Send current users to newly connected client
    socket.emit('users_data', usersCache);
});

function broadcastAttendanceLog(logData) {
    console.log('Real-time punch data:', logData);
    
    // Enhance log data with user information if available
    const enhancedLog = {
        ...logData,
        userInfo: usersCache.find(user => user.userId === logData.userId) || null
    };
    
    io.emit('new_attendance_log', enhancedLog);
}

// Initialize Device Connection with Real-Time Data
async function initializeDevice() {
    try {
        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, 10000);
        await deviceInstance.createSocket();
        console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);

        // Get users and cache them
        usersCache = await deviceInstance.getUsers();
        console.log('Total users on device:', usersCache.length);

        // Set up real-time logging
        await deviceInstance.getRealTimeLogs((realTimeLog) => {
            // The realTimeLog should contain:
            // - userId: The ID of the user who punched
            // - timestamp: When the punch occurred
            // - verificationMethod: How they verified (fingerprint, PIN, card, etc.)
            // - punchType: Check-in/check-out (if supported by device)
            
            console.log('Raw real-time log:', realTimeLog);
            broadcastAttendanceLog(realTimeLog);
        });

        console.log('Listening for real-time attendance logs...');

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