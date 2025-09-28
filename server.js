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

// ===== ENHANCED HELPER FUNCTIONS =====
function decodeDeviceString(str) {
    if (!str || typeof str !== 'string') return 'Unknown';
    
    // Remove non-printable characters and try to extract readable content
    try {
        // First attempt: Remove non-printable ASCII characters
        let cleanStr = str.replace(/[^\x20-\x7E]/g, '');
        
        if (cleanStr.length > 0) {
            return cleanStr || 'Unknown';
        }
        
        // Second attempt: Try to decode as hex or find patterns
        const buffer = Buffer.from(str, 'binary');
        
        // Look for MAC address pattern
        const macMatch = buffer.toString('hex').match(/([0-9a-f]{2}[:-]){5}([0-9a-f]{2})/i);
        if (macMatch) return macMatch[0];
        
        // Try to find any readable ASCII sequences
        const asciiSequences = [];
        for (let i = 0; i < buffer.length; i++) {
            if (buffer[i] >= 32 && buffer[i] <= 126) {
                asciiSequences.push(String.fromCharCode(buffer[i]));
            }
        }
        
        if (asciiSequences.length > 0) {
            return asciiSequences.join('') || 'Unknown';
        }
        
        return 'Unreadable Data';
    } catch (error) {
        console.error('Error decoding device string:', error);
        return 'Decoding Error';
    }
}

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

// Safe device method caller with error handling
async function safeDeviceCall(methodName, defaultValue = 'Unknown') {
    if (!deviceInstance) return defaultValue;
    
    try {
        const result = await deviceInstance[methodName]();
        return decodeDeviceString(result) || defaultValue;
    } catch (error) {
        console.error(`Error calling ${methodName}:`, error.message);
        return defaultValue;
    }
}

// ===== ENHANCED API ROUTES =====

// API route to get device information
app.get('/api/device-info', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const formattedInfo = {
            'IP Address': DEVICE_IP,
            'Port': DEVICE_PORT,
            'Connection Status': 'Connected'
        };

        // Get basic device info
        try {
            const basicInfo = await deviceInstance.getInfo();
            formattedInfo['Total Users'] = basicInfo?.userCount || 0;
            formattedInfo['Total Attendance Records'] = basicInfo?.attendanceCount || 0;
        } catch (e) {
            console.error('Error getting basic info:', e);
        }

        // Get detailed device information with safe calls
        formattedInfo['Device Name'] = await safeDeviceCall('getDeviceName');
        formattedInfo['Firmware Version'] = await safeDeviceCall('getDeviceVersion');
        formattedInfo['Platform'] = await safeDeviceCall('getPlatform');
        formattedInfo['Operating System'] = await safeDeviceCall('getOS');
        formattedInfo['Vendor'] = await safeDeviceCall('getVendor');
        formattedInfo['MAC Address'] = await safeDeviceCall('getMacAddress');
        formattedInfo['Manufacturing Date'] = await safeDeviceCall('getProductTime');
        formattedInfo['Serial Number'] = await safeDeviceCall('getSerialNumber');

        // Get face detection status
        try {
            formattedInfo['Face Detection'] = await deviceInstance.getFaceOn() ? 'Enabled' : 'Disabled';
        } catch (e) {
            console.error('Error getting face detection status:', e);
            formattedInfo['Face Detection'] = 'Unknown';
        }

        // Get device time
        try {
            const deviceTime = await deviceInstance.getTime();
            formattedInfo['Device Time'] = deviceTime ? new Date(deviceTime).toLocaleString() : 'Unknown';
        } catch (e) {
            console.error('Error getting device time:', e);
        }
 
        // Clean up the info object
        const cleanInfo = Object.fromEntries(
            Object.entries(formattedInfo).filter(([_, value]) => 
                value != null && value !== 'Unknown' && value !== 'Decoding Error'
            )
        );

        res.status(200).json(cleanInfo);
    } catch (error) {
        console.error('Error fetching device info:', error);
        res.status(500).json({ 
            error: 'Failed to fetch device information',
            details: error.message
        });
    }
});

// API route to get all users
app.get('/api/users', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        console.log('Fetching users from device...');
        let users = await deviceInstance.getUsers();
        
        // Handle if users is an object with a data property
        if (users && typeof users === 'object' && !Array.isArray(users)) {
            users = Object.values(users).find(val => Array.isArray(val)) || [];
        }
        
        // Ensure we have an array
        users = Array.isArray(users) ? users : [];
        
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
        
        if (!userId || !name) {
            return res.status(400).json({ error: 'User ID and Name are required' });
        }
        
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
        
        // Broadcast updated users list
        io.emit('users_data', usersCache);
        
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
        
        // Broadcast updated users list
        io.emit('users_data', usersCache);
        
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
        
        // Broadcast updated users list
        io.emit('users_data', usersCache);
        
        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user from device' });
    }
});

// API route to get attendance history
app.get('/api/attendance', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }

    try {
        console.log('Fetching attendance logs from device...');
        
        // Get date filter from query parameters
        const filterDate = req.query.date; // Format: YYYY-MM-DD
        
        let deviceLogs;
        
        try {
            deviceLogs = await deviceInstance.getAttendances();
            console.log('Successfully fetched logs using getAttendances()');
        } catch (error) {
            console.error('Error fetching attendance with getAttendances:', error);
            throw new Error(`Failed to fetch attendance: ${error.message}`);
        }

        if (!deviceLogs) {
            console.error('No attendance data received');
            return res.status(500).json({ error: 'No data received from device' });
        }
        
        if (!Array.isArray(deviceLogs)) {
            if (deviceLogs && typeof deviceLogs === 'object') {
                deviceLogs = Object.values(deviceLogs).find(val => Array.isArray(val)) || [];
            } else {
                deviceLogs = [];
            }
        }

        // Process the logs into consistent format
        let processedLogs = deviceLogs.map((log, index) => {
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
                rawData: log
            };
        });

        // Filter by date if provided
        if (filterDate) {
            processedLogs = processedLogs.filter(log => {
                const logDate = new Date(log.timestamp).toISOString().split('T')[0];
                return logDate === filterDate;
            });
        }

        // Sort by timestamp (newest first)
        processedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Update global attendance history
        attendanceHistory = processedLogs;

        res.status(200).json({
            success: true,
            total: processedLogs.length,
            records: processedLogs,
            lastUpdated: new Date().toISOString(),
            filterDate: filterDate || 'all'
        });

    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ 
            error: 'Failed to fetch attendance data',
            details: error.message
        });
    }
});

// Diagnostic endpoint
app.get('/api/diagnostic', async (_req, res) => {
    const diagnostic = {
        server: {
            status: 'running',
            port: EXPRESS_PORT,
            uptime: process.uptime()
        },
        device: {
            connected: !!deviceInstance,
            ip: DEVICE_IP,
            port: DEVICE_PORT
        },
        data: {
            users: usersCache.length,
            attendance: attendanceHistory.length
        }
    };

    if (deviceInstance) {
        try {
            // Test basic communication
            const testUsers = await deviceInstance.getUsers();
            diagnostic.device.users = Array.isArray(testUsers) ? testUsers.length : 'error';
            
            const testAttendance = await deviceInstance.getAttendances();
            diagnostic.device.attendance = Array.isArray(testAttendance) ? testAttendance.length : 'error';
            
            diagnostic.device.status = 'operational';
        } catch (error) {
            diagnostic.device.status = 'communication error: ' + error.message;
        }
    }

    res.json(diagnostic);
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

    // Handle refresh requests from client
    socket.on('refresh_attendance', async () => {
        try {
            if (deviceInstance) {
                const logs = await deviceInstance.getAttendances();
                if (logs && Array.isArray(logs)) {
                    const processedLogs = logs.map((log, index) => {
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
                            rawData: log
                        };
                    });
                    
                    attendanceHistory = processedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                    socket.emit('attendance_history', attendanceHistory);
                }
            }
        } catch (error) {
            console.error('Error refreshing attendance:', error);
            socket.emit('error', { message: 'Failed to refresh attendance data' });
        }
    });

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

// ===== ENHANCED DEVICE INITIALIZATION =====
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
        // Handle users data which may be an object or array
        if (users && typeof users === 'object' && !Array.isArray(users)) {
            usersCache = Object.values(users).find(val => Array.isArray(val)) || [];
        } else {
            usersCache = Array.isArray(users) ? users : [];
        }
        console.log('Total users on device:', usersCache.length);

        // Get initial attendance data
        try {
            const attendance = await deviceInstance.getAttendances();
            if (attendance && Array.isArray(attendance)) {
                attendanceHistory = attendance.map((log, index) => {
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
                        rawData: log
                    };
                }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
                
                console.log('Loaded initial attendance records:', attendanceHistory.length);
            }
        } catch (error) {
            console.error('Error loading initial attendance:', error);
        }

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

        // Broadcast connection status
        io.emit('device_connection', { status: 'connected', message: 'Device connected successfully' });

    } catch (error) {
        console.error('Failed to connect to device:', error.message);
        if (deviceInstance) {
            deviceInstance.disconnect();
            deviceInstance = null;
        }
        connectionAttempts++;
        
        // Broadcast connection error
        io.emit('device_connection', { 
            status: 'disconnected', 
            message: `Connection attempt ${connectionAttempts}/${MAX_RETRIES} failed` 
        });
        
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