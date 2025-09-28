import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import Zkteco from 'zkteco-js';
import cors from 'cors';

const app = express();
const server = http.createServer(app);

// Configure CORS for Express
app.use(cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
}));

// Configure CORS for Socket.IO
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const EXPRESS_PORT = process.env.EXPRESS_PORT || 3000;
const DEVICE_IP = '118.179.40.236';
const DEVICE_PORT = 4370;
const CONNECTION_TIMEOUT = 5000; // 5 seconds timeout
const MAX_RETRIES = 5;

let deviceInstance;
let connectionAttempts = 0;
let usersCache = [];
let attendanceHistory = []; // Store attendance history

// Middleware
app.use(express.json());
app.use(express.static('public')); // Serve static files

// ===== HELPER FUNCTIONS =====
function findUserName(userId) {
    if (!usersCache || !Array.isArray(usersCache)) return 'Unknown';
    const user = usersCache.find(u => u.userId == userId || u.id == userId);
    return user ? user.name : 'Unknown';
}

function determineVerificationMethod(logData) {
    if (!logData) return 'Unknown';
    
    const verificationType = logData.type; // ZKTeco uses 'type' field
    
    switch (verificationType) {
        case 0: return 'Password';
        case 1: return 'Fingerprint';
        case 2: return 'Card';
        case 3: return 'Face';
        case 4: return 'Fingerprint or Password';
        case 15: return 'Fingerprint or Password';
        default: return 'Unknown';
    }
}

function determinePunchType(logData) {
    if (!logData) return 'Unknown';
    
    const status = logData.state; // ZKTeco uses 'state' field
    
    switch (status) {
        case 0: return 'Check-in';
        case 1: return 'Check-out';
        case 2: return 'Break-out';
        case 3: return 'Break-in';
        case 4: return 'Overtime-in';
        case 5: return 'Overtime-out';
        default: return 'Unknown';
    }
}

// Function to parse ZKTeco record_time format
function parseZktecoTime(recordTime) {
    if (!recordTime) return new Date();
    
    // Handle the format: "Sun Sep 28 2025 11:57:56 GMT+0600 (Bangladesh Standard Time)"
    try {
        // Extract the main date part before the timezone
        const datePart = recordTime.split(' GMT')[0];
        return new Date(datePart);
    } catch (error) {
        console.error('Error parsing date:', recordTime, error);
        return new Date();
    }
}

// ===== API ROUTES =====

// API route to get device information
app.get('/api/device-info', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const deviceInfo = await deviceInstance.getInfo();
        res.status(200).json(deviceInfo);
    } catch (error) {
        console.error('Error fetching device info:', error);
        res.status(500).json({ error: 'Failed to fetch device information' });
    }
});

// API route to get all users
app.get('/api/users', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        console.log('Fetching users from device...');
        const users = await deviceInstance.getUsers();
        
        if (!users || !Array.isArray(users)) {
            console.error('Invalid users data received:', users);
            return res.status(500).json({ error: 'Invalid data received from device' });
        }
        
        console.log(`Successfully fetched ${users.length} users from device`);
        usersCache = users;
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ 
            error: 'Failed to fetch users from device',
            details: error.message
        });
    }
});

// API route to add a new user
app.post('/api/users', async (req, res) => {
    if (!deviceInstance) {
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
        res.status(500).json({ error: 'Failed to add user to device' });
    }
});

// API route to update a user
app.put('/api/users/:userId', async (req, res) => {
    if (!deviceInstance) {
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
        res.status(500).json({ error: 'Failed to update user on device' });
    }
});

// API route to delete a user
app.delete('/api/users/:userId', async (req, res) => {
    if (!deviceInstance) {
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
        res.status(500).json({ error: 'Failed to delete user from device' });
    }
});

// API route to get attendance history - CORRECTED VERSION
app.get('/api/attendance', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }

    try {
        console.log('Fetching attendance logs from device...');
        
        let deviceLogs;
        let methodUsed = 'getAttendances';
        
        try {
            // Use the correct method: getAttendances
            deviceLogs = await deviceInstance.getAttendances();
            console.log('Successfully fetched logs using getAttendances()');
        } catch (error) {
            console.error('Error fetching attendance with getAttendances:', error);
            throw new Error(`Failed to fetch attendance: ${error.message}`);
        }

        // Validate the received data
        if (!deviceLogs) {
            console.error('No attendance data received');
            return res.status(500).json({ error: 'No data received from device' });
        }
        
        if (!Array.isArray(deviceLogs)) {
            console.error('Invalid attendance data format:', typeof deviceLogs);
            // Sometimes it might be an object, try to extract array
            if (deviceLogs && typeof deviceLogs === 'object') {
                deviceLogs = Object.values(deviceLogs).find(val => Array.isArray(val)) || [];
            } else {
                deviceLogs = [];
            }
        }
        
        console.log(`Successfully fetched ${deviceLogs.length} attendance records`);

        // Process the logs into consistent format
        const processedLogs = deviceLogs.map((log, index) => {
            // Parse ZKTeco timestamp format
            const timestamp = parseZktecoTime(log.record_time);
            const userId = log.user_id || log.userId || 'Unknown';
            
            return {
                id: `att-${timestamp.getTime()}-${index}`,
                userId: userId,
                userName: findUserName(userId),
                timestamp: timestamp.toISOString(),
                date: timestamp.toLocaleDateString(),
                time: timestamp.toLocaleTimeString(),
                verificationMethod: determineVerificationMethod(log),
                punchType: determinePunchType(log),
                deviceIp: DEVICE_IP,
                methodUsed: methodUsed,
                rawData: log
            };
        });

        // Sort by timestamp (newest first)
        processedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Update global attendance history
        attendanceHistory = processedLogs;

        // Return the attendance data
        res.status(200).json({
            success: true,
            total: processedLogs.length,
            records: processedLogs,
            lastUpdated: new Date().toISOString(),
            source: methodUsed
        });

    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ 
            error: 'Failed to fetch attendance data',
            details: error.message
        });
    }
});

// Handle preflight requests for all routes
app.options('*', cors());

// ===== SOCKET.IO HANDLERS =====
io.on('connection', (socket) => {
    console.log('A web client connected');
    
    // Send current data to newly connected client
    socket.emit('users_data', usersCache);
    socket.emit('attendance_history', attendanceHistory);
    
    // Send device info to the client
    if (deviceInstance) {
        deviceInstance.getInfo()
            .then(info => socket.emit('device_info', info))
            .catch(error => console.error('Error getting device info:', error));
    }

    socket.on('disconnect', () => {
        console.log('A web client disconnected');
    });
});

// Function to process and broadcast real-time attendance data
function processAndBroadcastAttendance(logData) {
    console.log('Raw real-time attendance data:', logData);
    
    if (!logData) return;
    
    // Parse ZKTeco timestamp format for real-time data
    const timestamp = parseZktecoTime(logData.record_time);
    const userId = logData.user_id || logData.userId || 'Unknown';
    
    const attendanceRecord = {
        id: `realtime-${timestamp.getTime()}-${Math.random().toString(36).substr(2, 9)}`,
        userId: userId,
        userName: findUserName(userId),
        timestamp: timestamp.toISOString(),
        date: timestamp.toLocaleDateString(),
        time: timestamp.toLocaleTimeString(),
        verificationMethod: determineVerificationMethod(logData),
        punchType: determinePunchType(logData),
        deviceIp: DEVICE_IP,
        rawData: logData
    };
    
    console.log('Processed real-time attendance record:', attendanceRecord);
    
    // Add to history (keep only last 1000 records)
    attendanceHistory.unshift(attendanceRecord);
    if (attendanceHistory.length > 1000) {
        attendanceHistory = attendanceHistory.slice(0, 1000);
    }
    
    // Broadcast to all connected clients
    io.emit('attendance_record', attendanceRecord);
    io.emit('attendance_history', attendanceHistory);
}

// ===== DEVICE INITIALIZATION =====
async function initializeDevice() {
    try {
        if (connectionAttempts >= MAX_RETRIES) {
            console.log('Max connection attempts reached. Waiting 1 minute before trying again...');
            connectionAttempts = 0;
            setTimeout(initializeDevice, 60000);
            return;
        }

        console.log('Attempting to connect to device...');
        deviceInstance = null; // Reset device instance

        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, CONNECTION_TIMEOUT);
        
        await Promise.race([
            deviceInstance.createSocket(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT)
            )
        ]);

        console.log(`Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);

        // Get device info
        const deviceInfo = await deviceInstance.getInfo();
        console.log('Device Info:', deviceInfo);

        // Get users and cache them
        const users = await deviceInstance.getUsers();
        if (!users || !Array.isArray(users)) {
            console.error('Invalid users data received:', users);
            usersCache = [];
        } else {
            usersCache = users;
        }
        console.log('Total users on device:', usersCache.length);

        // Set up real-time attendance monitoring
        try {
            await deviceInstance.getRealTimeLogs((realTimeLog) => {
                processAndBroadcastAttendance(realTimeLog);
            });
            console.log('Listening for real-time attendance data...');
        } catch (error) {
            console.error('Failed to setup real-time monitoring:', error.message);
        }

        connectionAttempts = 0; // Reset attempts on successful connection

    } catch (error) {
        console.error('Failed to connect to device:', error.message);
        if (deviceInstance) {
            deviceInstance.disconnect();
            deviceInstance = null;
        }
        connectionAttempts++;
        console.log(`Connection attempt ${connectionAttempts}/${MAX_RETRIES}. Retrying in 5 seconds...`);
        setTimeout(initializeDevice, 5000);
    }
}

// ===== SERVER STARTUP =====
server.listen(EXPRESS_PORT, () => {
    console.log(`Server running on port ${EXPRESS_PORT}`);
    console.log(`Attempting to connect to ZKTeco device at ${DEVICE_IP}:${DEVICE_PORT}`);
    initializeDevice();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    if (deviceInstance) {
        deviceInstance.disconnect();
        console.log('Disconnected from ZKTeco device');
    }
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});