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

// Middleware and Routes
app.use(express.json());

app.get('/api/users', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const users = await deviceInstance.getUsers();
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users from device' });
    }
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
    console.log('A web client connected');
});

function broadcastAttendanceLog(logData) {
    console.log('Broadcasting real-time log:', logData);
    io.emit('new_attendance_log', logData);
}

// Initialize Device Connection with Real-Time Data
async function initializeDevice() {
    try {
        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, 10000);
        await deviceInstance.createSocket();
        console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);

        // Get users to verify connection
        const users = await deviceInstance.getUsers();
        console.log('Total users on device:', users.length);

        // Use getRealTimeLogs instead of enableRealtime
        await deviceInstance.getRealTimeLogs((realTimeLog) => {
            console.log('Real-time log:', realTimeLog);
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