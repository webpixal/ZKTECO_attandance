// server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Zkteco = require('zkteco-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const EXPRESS_PORT = process.env.EXPRESS_PORT || 5500;
const DEVICE_IP = '192.168.159.201';
const DEVICE_PORT = 4370;

let deviceInstance;
let usersCache = []; // Cache to store user data

// Middleware and Routes
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Serve the dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

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
    
    // Send current users to newly connected client
    socket.emit('users_data', usersCache);
    
    // Send device connection status
    socket.emit('device_status', {
        connected: !!deviceInstance,
        ip: DEVICE_IP,
        port: DEVICE_PORT
    });
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
        
        // Broadcast device connection status
        io.emit('device_status', {
            connected: true,
            ip: DEVICE_IP,
            port: DEVICE_PORT
        });

        // Set up real-time logging
        await deviceInstance.getRealTimeLogs((realTimeLog) => {
            console.log('Raw real-time log:', realTimeLog);
            broadcastAttendanceLog(realTimeLog);
        });

        console.log('Listening for real-time attendance logs...');

    } catch (error) {
        console.error('Failed to connect to device:', error);
        if (deviceInstance) {
            deviceInstance.disconnect();
        }
        
        // Broadcast device disconnection status
        io.emit('device_status', {
            connected: false,
            ip: DEVICE_IP,
            port: DEVICE_PORT,
            error: error.message
        });
        
        // Attempt to reconnect after a delay if connection fails
        setTimeout(initializeDevice, 5000); 
    }
}

// Start Server
server.listen(EXPRESS_PORT, () => {
    console.log(`Server running on port ${EXPRESS_PORT}`);
    initializeDevice();
});