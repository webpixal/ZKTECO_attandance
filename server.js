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

const EXPRESS_PORT = process.env.EXPRESS_PORT || 3500;
const DEVICE_IP = '118.179.40.236';
const DEVICE_PORT = 4370;
const CONNECTION_TIMEOUT = 5000;
const MAX_RETRIES = 5;

// External API Configuration with enhanced settings
const EXTERNAL_API_CONFIG = {
    enabled: true,
    url: 'https://laureates.aljaami.co.uk/api/pop.php',
    maxRetries: 3,
    retryDelay: 2000,
    timeout: 10000
};

// Track push statistics
const pushStatistics = {
    totalPushes: 0,
    successfulPushes: 0,
    failedPushes: 0,
    lastPush: null,
    lastSuccess: null,
    lastError: null
};

let deviceInstance;
let connectionAttempts = 0;
let usersCache = [];
let attendanceHistory = [];

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ===== ENHANCED HELPER FUNCTIONS =====
function decodeDeviceString(str) {
    if (!str || typeof str !== 'string') return 'Unknown';
    try {
        let cleanStr = str.replace(/[^\x20-\x7E]/g, '');
        return cleanStr || 'Unknown';
    } catch (error) {
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
    const verificationType = logData.type;
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
    const status = logData.state;
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

function parseZktecoTime(recordTime) {
    if (!recordTime) return new Date();
    try {
        const datePart = recordTime.split(' GMT')[0];
        return new Date(datePart);
    } catch (error) {
        return new Date();
    }
}

// ===== ENHANCED EXTERNAL API PUSH =====
async function pushToExternalAPI(attendanceData, retryCount = 0) {
    if (!EXTERNAL_API_CONFIG.enabled) {
        return { 
            success: false, 
            message: 'External API disabled',
            retryCount: retryCount
        };
    }

    pushStatistics.totalPushes++;

    try {
        const emp_code = attendanceData.userId;
        const punch_time = new Date(attendanceData.timestamp).toTimeString().split(' ')[0];

        const payload = {
            emp_code: emp_code,
            punch_time: punch_time
        };

        console.log(`🔄 [Attempt ${retryCount + 1}] Pushing to external API:`, payload);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_API_CONFIG.timeout);

        const response = await fetch(EXTERNAL_API_CONFIG.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const responseData = await response.json();
        
        pushStatistics.successfulPushes++;
        pushStatistics.lastPush = new Date().toISOString();
        pushStatistics.lastSuccess = new Date().toISOString();

        console.log('✅ External API push SUCCESS:', {
            emp_code: emp_code,
            punch_time: punch_time,
            response: responseData
        });

        return {
            success: true,
            data: responseData,
            payload: payload,
            retryCount: retryCount,
            timestamp: new Date().toISOString()
        };

    } catch (error) {
        pushStatistics.failedPushes++;
        pushStatistics.lastError = error.message;
        
        console.error(`❌ External API push FAILED (Attempt ${retryCount + 1}):`, error.message);

        // Retry logic
        if (retryCount < EXTERNAL_API_CONFIG.maxRetries) {
            console.log(`🔄 Retrying in ${EXTERNAL_API_CONFIG.retryDelay}ms...`);
            await new Promise(resolve => setTimeout(resolve, EXTERNAL_API_CONFIG.retryDelay));
            return pushToExternalAPI(attendanceData, retryCount + 1);
        }

        return {
            success: false,
            error: error.message,
            payload: {
                emp_code: attendanceData.userId,
                punch_time: new Date(attendanceData.timestamp).toTimeString().split(' ')[0]
            },
            retryCount: retryCount,
            timestamp: new Date().toISOString()
        };
    }
}

// ===== API ROUTES =====

// Device Information
app.get('/api/device-info', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const formattedInfo = {
            'IP Address': DEVICE_IP,
            'Port': DEVICE_PORT,
            'Connection Status': 'Connected',
            'External API': EXTERNAL_API_CONFIG.enabled ? 'Enabled' : 'Disabled'
        };

        try {
            const basicInfo = await deviceInstance.getInfo();
            formattedInfo['Total Users'] = basicInfo?.userCount || 0;
            formattedInfo['Total Attendance Records'] = basicInfo?.attendanceCount || 0;
        } catch (e) {
            console.error('Error getting basic info:', e);
        }

        res.status(200).json(formattedInfo);
    } catch (error) {
        console.error('Error fetching device info:', error);
        res.status(500).json({ error: 'Failed to fetch device information' });
    }
});

// User Management
app.get('/api/users', async (_req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        let users = await deviceInstance.getUsers();
        if (users && typeof users === 'object' && !Array.isArray(users)) {
            users = Object.values(users).find(val => Array.isArray(val)) || [];
        }
        users = Array.isArray(users) ? users : [];
        usersCache = users;
        res.status(200).json(users);
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
        if (!userId || !name) {
            return res.status(400).json({ error: 'User ID and Name are required' });
        }
        const user = {
            userId: parseInt(userId),
            name: name,
            cardNumber: cardNumber || 0,
            role: role || 0,
            password: password || ""
        };
        const result = await deviceInstance.setUser(user);
        usersCache = await deviceInstance.getUsers();
        io.emit('users_data', usersCache);
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
        const users = await deviceInstance.getUsers();
        const user = users.find(u => u.userId === userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (name) user.name = name;
        if (cardNumber) user.cardNumber = cardNumber;
        if (role) user.role = role;
        if (password) user.password = password;
        const result = await deviceInstance.setUser(user);
        usersCache = await deviceInstance.getUsers();
        io.emit('users_data', usersCache);
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
        const result = await deviceInstance.deleteUser(userId);
        usersCache = await deviceInstance.getUsers();
        io.emit('users_data', usersCache);
        res.status(200).json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user from device' });
    }
});

// Attendance Management
app.get('/api/attendance', async (req, res) => {
    if (!deviceInstance) {
        return res.status(503).json({ error: 'Device not connected' });
    }
    try {
        const filterDate = req.query.date;
        let deviceLogs;
        try {
            deviceLogs = await deviceInstance.getAttendances();
        } catch (error) {
            throw new Error(`Failed to fetch attendance: ${error.message}`);
        }
        if (!deviceLogs) {
            return res.status(500).json({ error: 'No data received from device' });
        }
        if (!Array.isArray(deviceLogs)) {
            deviceLogs = Object.values(deviceLogs).find(val => Array.isArray(val)) || [];
        }
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
        if (filterDate) {
            processedLogs = processedLogs.filter(log => {
                const logDate = new Date(log.timestamp).toISOString().split('T')[0];
                return logDate === filterDate;
            });
        }
        processedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
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
        res.status(500).json({ error: 'Failed to fetch attendance data' });
    }
});

// External API Management
app.post('/api/push-attendance', async (req, res) => {
    try {
        const { emp_code, punch_time } = req.body;
        if (!emp_code || !punch_time) {
            return res.status(400).json({ error: 'emp_code and punch_time are required' });
        }
        const payload = { emp_code, punch_time };
        console.log('Manual push to external API:', payload);
        const response = await fetch(EXTERNAL_API_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const responseData = await response.json();
        res.status(200).json({
            success: true,
            message: 'Attendance pushed successfully',
            data: responseData,
            payload: payload
        });
    } catch (error) {
        console.error('Error in manual push:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/external-api-status', (_req, res) => {
    res.json({
        enabled: EXTERNAL_API_CONFIG.enabled,
        url: EXTERNAL_API_CONFIG.url,
        description: 'External API for pushing attendance data'
    });
});

app.get('/api/push-statistics', (_req, res) => {
    res.json({
        enabled: EXTERNAL_API_CONFIG.enabled,
        config: EXTERNAL_API_CONFIG,
        statistics: pushStatistics,
        uptime: process.uptime()
    });
});

app.post('/api/toggle-external-api', (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled === 'boolean') {
        EXTERNAL_API_CONFIG.enabled = enabled;
        console.log(`External API ${enabled ? 'ENABLED' : 'DISABLED'}`);
        io.emit('external_api_config_changed', {
            enabled: EXTERNAL_API_CONFIG.enabled,
            timestamp: new Date().toISOString()
        });
        res.json({
            success: true,
            message: `External API ${enabled ? 'enabled' : 'disabled'}`,
            enabled: EXTERNAL_API_CONFIG.enabled
        });
    } else {
        res.status(400).json({ success: false, error: 'Invalid enabled parameter' });
    }
});

app.post('/api/push-record/:recordId', async (req, res) => {
    try {
        const recordId = req.params.recordId;
        const record = attendanceHistory.find(r => r.id === recordId);
        if (!record) {
            return res.status(404).json({ success: false, error: 'Record not found' });
        }
        console.log('Manual push requested for record:', recordId);
        const result = await pushToExternalAPI(record);
        res.json({
            success: result.success,
            message: result.success ? 'Record pushed successfully' : result.error,
            recordId: recordId,
            result: result
        });
    } catch (error) {
        console.error('Error in manual push:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Dashboard Statistics
app.get('/api/dashboard/stats', async (_req, res) => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const todayRecords = attendanceHistory.filter(record => 
            new Date(record.timestamp).toISOString().split('T')[0] === today
        );
        
        const stats = {
            totalEmployees: usersCache.length,
            presentToday: todayRecords.filter(record => record.punchType === 'Check-in').length,
            pendingLeaves: 0, // You can implement leave management later
            activeShifts: 0,  // You can implement shift management later
            totalAttendance: attendanceHistory.length,
            externalApiPushes: pushStatistics.totalPushes,
            externalApiSuccessRate: pushStatistics.totalPushes > 0 ? 
                (pushStatistics.successfulPushes / pushStatistics.totalPushes * 100).toFixed(2) + '%' : '0%'
        };

        res.json(stats);
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard statistics' });
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
        external_api: EXTERNAL_API_CONFIG,
        data: {
            users: usersCache.length,
            attendance: attendanceHistory.length
        },
        push_statistics: pushStatistics
    };

    if (deviceInstance) {
        try {
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

// Health check
app.get('/', (_req, res) => {
    res.json({
        status: 'OK',
        message: 'HR Management System is running',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
    });
});

// Handle preflight requests
app.options('*', cors());

// ===== SOCKET.IO REAL-TIME HANDLERS =====
io.on('connection', (socket) => {
    console.log('🔌 New client connected for real-time monitoring');
    
    // Send current data to newly connected client
    socket.emit('users_data', usersCache);
    socket.emit('attendance_history', attendanceHistory);
    socket.emit('push_statistics', pushStatistics);
    socket.emit('external_api_config', EXTERNAL_API_CONFIG);
    
    if (deviceInstance) {
        deviceInstance.getInfo()
            .then(info => socket.emit('device_info', info))
            .catch(error => console.error('Error getting device info:', error));
    }

    socket.on('toggle_external_api', (data) => {
        if (typeof data.enabled === 'boolean') {
            EXTERNAL_API_CONFIG.enabled = data.enabled;
            console.log(`Client requested external API ${data.enabled ? 'ENABLE' : 'DISABLE'}`);
            io.emit('external_api_config_changed', {
                enabled: EXTERNAL_API_CONFIG.enabled,
                timestamp: new Date().toISOString()
            });
        }
    });

    socket.on('manual_push_record', async (data) => {
        const record = attendanceHistory.find(r => r.id === data.recordId);
        if (record) {
            console.log('Manual push requested via socket for record:', data.recordId);
            const result = await pushToExternalAPI(record);
            socket.emit('manual_push_result', {
                recordId: data.recordId,
                success: result.success,
                message: result.success ? 'Manual push successful' : result.error,
                result: result
            });
        } else {
            socket.emit('manual_push_result', {
                recordId: data.recordId,
                success: false,
                message: 'Record not found'
            });
        }
    });

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
        console.log('🔌 Client disconnected');
    });
});

// ===== REAL-TIME ATTENDANCE PROCESSING =====
async function processAndBroadcastAttendance(logData) {
    console.log('📥 Raw real-time attendance data received');
    
    if (!logData) return;
    
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
        rawData: logData,
        externalApiPush: null
    };
    
    console.log('📊 Processed real-time attendance record:', {
        userId: attendanceRecord.userId,
        userName: attendanceRecord.userName,
        punchType: attendanceRecord.punchType,
        time: attendanceRecord.time
    });
    
    // ===== REAL-TIME EXTERNAL API PUSH =====
    if (EXTERNAL_API_CONFIG.enabled) {
        console.log('🚀 Starting real-time external API push...');
        
        pushToExternalAPI(attendanceRecord)
            .then(apiResult => {
                attendanceRecord.externalApiPush = apiResult;
                
                if (apiResult.success) {
                    console.log('✅ REAL-TIME PUSH SUCCESS:', {
                        emp_code: apiResult.payload.emp_code,
                        punch_time: apiResult.payload.punch_time,
                        attempts: apiResult.retryCount + 1
                    });
                } else {
                    console.log('❌ REAL-TIME PUSH FAILED after', apiResult.retryCount + 1, 'attempts:', apiResult.error);
                }
                
                io.emit('external_api_push', {
                    recordId: attendanceRecord.id,
                    success: apiResult.success,
                    message: apiResult.success ? 
                        `Successfully pushed to external API (${apiResult.retryCount + 1} attempt(s))` : 
                        `Failed after ${apiResult.retryCount + 1} attempt(s): ${apiResult.error}`,
                    payload: apiResult.payload,
                    timestamp: new Date().toISOString(),
                    statistics: pushStatistics
                });
                
                io.emit('attendance_record_updated', attendanceRecord);
            })
            .catch(error => {
                console.error('🚨 Unhandled error in external API push:', error);
                attendanceRecord.externalApiPush = {
                    success: false,
                    error: error.message,
                    timestamp: new Date().toISOString()
                };
                io.emit('external_api_push', {
                    recordId: attendanceRecord.id,
                    success: false,
                    message: `Unhandled error: ${error.message}`,
                    timestamp: new Date().toISOString()
                });
            });
    }
    
    attendanceHistory.unshift(attendanceRecord);
    if (attendanceHistory.length > 1000) {
        attendanceHistory = attendanceHistory.slice(0, 1000);
    }
    
    io.emit('attendance_record', attendanceRecord);
    io.emit('attendance_history', attendanceHistory);
    io.emit('push_statistics', pushStatistics);
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
        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, CONNECTION_TIMEOUT);
        
        await Promise.race([
            deviceInstance.createSocket(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT)
            )
        ]);

        console.log(`✅ Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);
        console.log(`🔗 External API: ${EXTERNAL_API_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);

        const deviceInfo = await deviceInstance.getInfo();
        console.log('Device Info:', deviceInfo);

        const users = await deviceInstance.getUsers();
        if (users && typeof users === 'object' && !Array.isArray(users)) {
            usersCache = Object.values(users).find(val => Array.isArray(val)) || [];
        } else {
            usersCache = Array.isArray(users) ? users : [];
        }
        console.log('Total users on device:', usersCache.length);

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

        try {
            await deviceInstance.getRealTimeLogs((realTimeLog) => {
                processAndBroadcastAttendance(realTimeLog);
            });
            console.log('👂 Listening for real-time attendance data...');
        } catch (error) {
            console.error('Failed to setup real-time monitoring:', error.message);
        }

        connectionAttempts = 0;
        io.emit('device_connection', { 
            status: 'connected', 
            message: 'Device connected successfully',
            external_api: EXTERNAL_API_CONFIG.enabled
        });

    } catch (error) {
        console.error('Failed to connect to device:', error.message);
        if (deviceInstance) {
            deviceInstance.disconnect();
            deviceInstance = null;
        }
        connectionAttempts++;
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
    console.log(`🚀 HR Management System running on port ${EXPRESS_PORT}`);
    console.log(`📱 Dashboard: http://localhost:${EXPRESS_PORT}`);
    console.log(`🔗 Device: ${DEVICE_IP}:${DEVICE_PORT}`);
    console.log(`🌐 External API: ${EXTERNAL_API_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`📊 API Documentation available via Postman collection`);
    initializeDevice();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    if (deviceInstance) {
        deviceInstance.disconnect();
        console.log('📴 Disconnected from ZKTeco device');
    }
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});