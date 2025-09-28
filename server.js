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
const DEVICE_IP = '192.168.159.201';
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

// ===== DEBUG ENDPOINT =====
app.get('/api/debug-methods', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    
    try {
        // Get all properties of the device instance
        const allProperties = Object.getOwnPropertyNames(deviceInstance);
        const prototypeMethods = Object.getOwnPropertyNames(Object.getPrototypeOf(deviceInstance));
        
        // Filter only functions
        const instanceMethods = allProperties.filter(prop => typeof deviceInstance[prop] === 'function');
        const prototypeFunctions = prototypeMethods.filter(prop => typeof deviceInstance[prop] === 'function');
        
        // Combine and remove duplicates
        const allMethods = [...new Set([...instanceMethods, ...prototypeFunctions])].sort();
        
        console.log('All available methods:', allMethods);
        
        // Try to get device info to test connection
        let deviceInfo;
        try {
            deviceInfo = await deviceInstance.getInfo();
        } catch (error) {
            deviceInfo = { error: error.message };
        }
        
        // Try to get users to test user methods
        let users;
        try {
            users = await deviceInstance.getUsers();
            users = { count: users.length, sample: users[0] };
        } catch (error) {
            users = { error: error.message };
        }
        
        res.status(200).json({
            availableMethods: allMethods,
            deviceConnected: true,
            deviceInfo: deviceInfo,
            usersTest: users,
            connectionInfo: {
                ip: DEVICE_IP,
                port: DEVICE_PORT,
                attempts: connectionAttempts
            }
        });
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to debug methods',
            details: error.message 
        });
    }
});

// ===== HELPER FUNCTIONS =====
function findUserName(userId) {
    if (!usersCache || !Array.isArray(usersCache)) return 'Unknown';
    const user = usersCache.find(u => u.userId === userId || u.id === userId);
    return user ? user.name : 'Unknown';
}

function determineVerificationMethod(logData) {
    if (!logData) return 'Unknown';
    
    const verificationType = logData.verificationType || logData.verifyType || logData.verification;
    
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
    
    const status = logData.status || logData.punch;
    
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

// API route to get attendance history - UPDATED WITH PROPER METHOD DETECTION
app.get('/api/attendance', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }

    try {
        console.log('Fetching attendance logs from device...');
        
        let deviceLogs;
        let methodUsed = 'unknown';
        
        // Check what methods are actually available
        const availableMethods = Object.getOwnPropertyNames(deviceInstance).filter(prop => 
            typeof deviceInstance[prop] === 'function'
        );
        
        console.log('Available methods for attendance:', availableMethods.filter(m => 
            m.toLowerCase().includes('log') || 
            m.toLowerCase().includes('attendance') ||
            m.toLowerCase().includes('data')
        ));

        // Try different possible method names for attendance
        const possibleMethods = [
            'getAttLogs', 'getAttendance', 'getLogs', 'getAttendances', 
            'getAttendanceData', 'getLogData', 'getAllLogs'
        ];

        for (const method of possibleMethods) {
            if (typeof deviceInstance[method] === 'function') {
                try {
                    console.log(`Trying method: ${method}`);
                    deviceLogs = await deviceInstance[method]();
                    methodUsed = method;
                    console.log(`Successfully fetched logs using ${method}`);
                    break;
                } catch (error) {
                    console.log(`Method ${method} failed:`, error.message);
                    continue;
                }
            }
        }

        // If no standard method worked, try real-time logs approach
        if (!deviceLogs) {
            console.log('No standard attendance method worked, checking real-time capabilities...');
            
            // For some ZKTeco devices, you need to use real-time logs and collect them over time
            // We'll return the history we've collected so far
            return res.status(200).json({
                success: true,
                total: attendanceHistory.length,
                records: attendanceHistory,
                lastUpdated: new Date().toISOString(),
                source: 'real_time_history',
                note: 'This device may not support direct attendance log retrieval. Data shown is from real-time monitoring.'
            });
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
        
        console.log(`Successfully fetched ${deviceLogs.length} attendance records using ${methodUsed}`);

        // Process the logs into consistent format
        const processedLogs = deviceLogs.map((log, index) => {
            // Handle different timestamp formats
            let timestamp;
            if (log.timestamp) {
                timestamp = new Date(log.timestamp);
            } else if (log.recordTime) {
                timestamp = new Date(log.recordTime);
            } else if (log.time) {
                timestamp = new Date(log.time);
            } else if (log.date) {
                timestamp = new Date(log.date);
            } else {
                timestamp = new Date(); // Fallback to current time
            }

            const userId = log.uid || log.userId || log.id || 'Unknown';
            
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
        attendanceHistory = [...processedLogs, ...attendanceHistory].slice(0, 1000);

        // Return the attendance data
        res.status(200).json({
            success: true,
            total: processedLogs.length,
            records: processedLogs,
            lastUpdated: new Date().toISOString(),
            source: methodUsed,
            methodUsed: methodUsed
        });

    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ 
            error: 'Failed to fetch attendance data',
            details: error.message,
            suggestion: 'Use /api/debug-methods endpoint to see available methods'
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
    
    // Handle timestamp
    let timestamp;
    if (logData.timestamp) {
        timestamp = new Date(logData.timestamp);
    } else if (logData.recordTime) {
        timestamp = new Date(logData.recordTime);
    } else if (logData.time) {
        timestamp = new Date(logData.time);
    } else {
        timestamp = new Date();
    }

    const userId = logData.uid || logData.userId || 'Unknown';
    
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

        // Debug: Log all available methods
        const allMethods = Object.getOwnPropertyNames(deviceInstance).filter(prop => 
            typeof deviceInstance[prop] === 'function'
        );
        console.log('All available device methods:', allMethods);

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
    console.log(`Debug endpoint available at: http://localhost:${EXPRESS_PORT}/api/debug-methods`);
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