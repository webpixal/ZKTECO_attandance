import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import Zkteco from 'zkteco-js';
import cors from 'cors';
import { EventEmitter } from 'events';

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
const CONNECTION_TIMEOUT = 10000; // Increased timeout for VPS
const MAX_RETRIES = 5;

// ===== SIMPLIFIED RUSH HANDLING CONFIGURATION =====
const RUSH_HANDLING_CONFIG = {
    enabled: true,
    maxConcurrentPushes: 3,
    queueSize: 500,
    processingDelay: 50,
    batchSize: 5,
    retryStrategy: {
        maxRetries: 2,
        baseDelay: 1000,
        maxDelay: 5000
    }
};

// External API Configuration
const EXTERNAL_API_CONFIG = {
    enabled: true,
    url: 'https://laureates.aljaami.co.uk/api/pop.php',
    timeout: 8000
};

// ===== POLLING CONFIGURATION =====
const POLLING_CONFIG = {
    enabled: true,
    interval: 5000, // Increased to 5 seconds for VPS stability
    maxRecordsPerPoll: 10
};

// ===== SIMPLIFIED RUSH HANDLING =====
const rushHandlingStats = {
    totalProcessed: 0,
    totalQueued: 0,
    totalDropped: 0,
    totalErrors: 0,
    queueLength: 0,
    concurrentPushes: 0
};

const pushQueue = [];
let isProcessingQueue = false;
let concurrentPushCount = 0;

// Track push statistics
const pushStatistics = {
    totalPushes: 0,
    successfulPushes: 0,
    failedPushes: 0,
    lastPush: null
};

let deviceInstance;
let connectionAttempts = 0;
let usersCache = [];
let attendanceHistory = [];
let lastPolledTimestamp = new Date();
let realTimeListenersActive = false;
let isPollingInProgress = false; // Prevent overlapping polls
let pollingInterval;

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ===== SIMPLIFIED QUEUE PROCESSING =====

/**
 * Add record to processing queue
 */
function addToProcessingQueue(attendanceRecord) {
    const queueItem = {
        id: `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        record: attendanceRecord,
        timestamp: new Date().toISOString(),
        attemptCount: 0
    };

    // Check queue size limit
    if (pushQueue.length >= RUSH_HANDLING_CONFIG.queueSize) {
        const dropped = pushQueue.shift();
        rushHandlingStats.totalDropped++;
        console.warn(`🚨 Queue full, dropped record: ${dropped.id}`);
    }

    pushQueue.push(queueItem);
    rushHandlingStats.totalQueued++;
    rushHandlingStats.queueLength = pushQueue.length;

    console.log(`📥 Added to queue: ${queueItem.id}. Queue length: ${pushQueue.length}`);

    // Start processing if not already running
    if (!isProcessingQueue) {
        setTimeout(processQueue, 10);
    }

    io.emit('queue_status', {
        queueLength: pushQueue.length,
        concurrentPushes: concurrentPushCount,
        stats: rushHandlingStats
    });

    return queueItem.id;
}

/**
 * Process the queue with controlled concurrency
 */
async function processQueue() {
    if (isProcessingQueue) {
        console.log('🔄 Queue processing already running, skipping...');
        return;
    }

    isProcessingQueue = true;
    console.log(`🚀 Starting queue processing. Items in queue: ${pushQueue.length}`);

    try {
        while (pushQueue.length > 0 && isProcessingQueue) {
            const availableSlots = RUSH_HANDLING_CONFIG.maxConcurrentPushes - concurrentPushCount;
            
            if (availableSlots <= 0) {
                console.log(`⏳ No available slots (${concurrentPushCount}/${RUSH_HANDLING_CONFIG.maxConcurrentPushes}). Waiting...`);
                await new Promise(resolve => setTimeout(resolve, RUSH_HANDLING_CONFIG.processingDelay));
                continue;
            }

            const batchSize = Math.min(availableSlots, RUSH_HANDLING_CONFIG.batchSize, pushQueue.length);
            const batch = pushQueue.splice(0, batchSize);
            rushHandlingStats.queueLength = pushQueue.length;

            console.log(`📦 Processing batch of ${batch.length} items`);

            const processingPromises = batch.map(item => processQueueItem(item));
            await Promise.allSettled(processingPromises);

            if (pushQueue.length > 0) {
                await new Promise(resolve => setTimeout(resolve, RUSH_HANDLING_CONFIG.processingDelay));
            }

            io.emit('queue_status', {
                queueLength: pushQueue.length,
                concurrentPushes: concurrentPushCount,
                stats: rushHandlingStats
            });
        }
    } catch (error) {
        console.error('❌ Error in queue processing:', error);
    } finally {
        isProcessingQueue = false;
        console.log('✅ Queue processing completed');
    }
}

/**
 * Process individual queue item
 */
async function processQueueItem(queueItem) {
    concurrentPushCount++;
    
    try {
        console.log(`🔧 Processing record ${queueItem.record.id} (Attempt ${queueItem.attemptCount + 1})`);

        const result = await pushToExternalAPI(queueItem.record, queueItem.attemptCount);

        if (result.success) {
            rushHandlingStats.totalProcessed++;
            console.log(`✅ Successfully processed: ${queueItem.record.id} -> ${result.payload.emp_code} ${result.payload.punch_time}`);
            
            io.emit('external_api_push', {
                recordId: queueItem.record.id,
                success: true,
                message: 'Auto-pushed successfully',
                payload: result.payload,
                timestamp: new Date().toISOString()
            });
        } else {
            rushHandlingStats.totalErrors++;
            console.error(`❌ Failed to process: ${queueItem.record.id} - ${result.error}`);
            
            if (queueItem.attemptCount < RUSH_HANDLING_CONFIG.retryStrategy.maxRetries) {
                queueItem.attemptCount++;
                const backoffDelay = RUSH_HANDLING_CONFIG.retryStrategy.baseDelay * Math.pow(2, queueItem.attemptCount);
                
                console.log(`🔄 Retrying in ${backoffDelay}ms (Attempt ${queueItem.attemptCount + 1})`);
                
                setTimeout(() => {
                    pushQueue.push(queueItem);
                    rushHandlingStats.queueLength = pushQueue.length;
                    if (!isProcessingQueue) {
                        processQueue();
                    }
                }, Math.min(backoffDelay, RUSH_HANDLING_CONFIG.retryStrategy.maxDelay));
            } else {
                console.error(`💀 Final failure after ${queueItem.attemptCount + 1} attempts: ${queueItem.record.id}`);
                
                io.emit('external_api_push', {
                    recordId: queueItem.record.id,
                    success: false,
                    message: `Failed after ${queueItem.attemptCount + 1} attempts: ${result.error}`,
                    timestamp: new Date().toISOString()
                });
            }
        }

    } catch (error) {
        console.error(`🚨 Unexpected error processing ${queueItem.record.id}:`, error);
        rushHandlingStats.totalErrors++;
    } finally {
        concurrentPushCount--;
    }
}

// ===== HELPER FUNCTIONS =====
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

// ===== EXTERNAL API PUSH =====
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
        
        const punch_time = new Date(attendanceData.timestamp);
        const formattedTime = punch_time.toLocaleTimeString('en-GB', { 
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });

        const formattedDate = punch_time.toISOString().split('T')[0];

        const payloadVariations = [
            {
                emp_code: emp_code,
                punch_time: formattedTime,
                punch_date: formattedDate,
                device_ip: DEVICE_IP,
                user_name: attendanceData.userName || 'Unknown'
            },
            {
                employee_code: emp_code,
                time: formattedTime,
                date: formattedDate
            },
            {
                emp_id: emp_code,
                punch_time: formattedTime,
                punch_date: formattedDate
            }
        ];

        let lastError = null;
        
        for (const payload of payloadVariations) {
            try {
                console.log(`\n📤 [PUSH START] Attempting to push attendance data:`);
                console.log(`   👤 Employee: ${attendanceData.userName} (${emp_code})`);
                console.log(`   🕒 Time: ${formattedTime}`);
                console.log(`   📅 Date: ${formattedDate}`);
                console.log(`   🔄 Attempt: ${retryCount + 1}`);
                console.log(`   📦 Payload:`, JSON.stringify(payload, null, 2));

                const response = await fetch(EXTERNAL_API_CONFIG.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(EXTERNAL_API_CONFIG.timeout)
                });

                const responseText = await response.text();
                let responseData;
                
                try {
                    responseData = JSON.parse(responseText);
                } catch (e) {
                    responseData = { message: responseText, raw: responseText };
                }

                console.log(`📡 [API RESPONSE] Status: ${response.status}`);
                console.log(`   Response:`, JSON.stringify(responseData, null, 2));

                if (response.ok) {
                    pushStatistics.successfulPushes++;
                    pushStatistics.lastPush = new Date().toISOString();

                    console.log(`✅ [PUSH SUCCESS] External API accepted the data`);
                    console.log(`   👤 Employee: ${emp_code}`);
                    console.log(`   🕒 Time: ${formattedTime}`);
                    console.log(`   📊 Response:`, responseData);

                    return {
                        success: true,
                        data: responseData,
                        payload: payload,
                        retryCount: retryCount
                    };
                } else {
                    lastError = new Error(`HTTP ${response.status}: ${response.statusText} - ${responseText}`);
                    console.warn(`⚠️ [PUSH FAILED] Payload format failed, trying next format...`);
                }
            } catch (error) {
                lastError = error;
                console.warn(`⚠️ [PUSH ERROR] Payload format error:`, error.message);
            }
        }

        throw lastError || new Error('All payload formats failed');

    } catch (error) {
        pushStatistics.failedPushes++;
        
        console.error(`❌ [PUSH FINAL FAILURE] All attempts failed:`);
        console.error(`   👤 Employee: ${attendanceData.userId}`);
        console.error(`   🕒 Time: ${new Date(attendanceData.timestamp).toLocaleTimeString('en-GB', { hour12: false })}`);
        console.error(`   📅 Date: ${new Date(attendanceData.timestamp).toISOString().split('T')[0]}`);
        console.error(`   ❌ Error: ${error.message}`);
        
        return {
            success: false,
            error: error.message,
            payload: {
                emp_code: attendanceData.userId,
                punch_time: new Date(attendanceData.timestamp).toLocaleTimeString('en-GB', { hour12: false }),
                punch_date: new Date(attendanceData.timestamp).toISOString().split('T')[0]
            },
            retryCount: retryCount
        };
    }
}

// ===== ENHANCED POLLING MECHANISM WITH ERROR HANDLING =====
async function pollForNewAttendances() {
    if (!deviceInstance || !POLLING_CONFIG.enabled || isPollingInProgress) {
        if (isPollingInProgress) {
            console.log('⏳ [POLLING] Previous poll still in progress, skipping...');
        }
        return;
    }

    isPollingInProgress = true;
    
    try {
        console.log(`\n🔍 [POLLING] Checking for new attendance records...`);
        
        // Add timeout to prevent hanging
        const pollPromise = deviceInstance.getAttendances();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Polling timeout')), 10000)
        );

        let deviceLogs;
        try {
            deviceLogs = await Promise.race([pollPromise, timeoutPromise]);
        } catch (pollError) {
            console.error('❌ [POLLING] Error getting attendance records:', pollError.message);
            
            // Handle specific ZKTeco errors
            if (pollError.message.includes('ERROR_IN_UNHANDLE_CMD') || 
                pollError.message.includes('UNKNOWN ERROR')) {
                console.log('🔄 [POLLING] Device communication error, attempting to reconnect...');
                await reinitializeDeviceConnection();
                return;
            }
            throw pollError;
        }

        if (!Array.isArray(deviceLogs)) {
            deviceLogs = Object.values(deviceLogs).find(val => Array.isArray(val)) || [];
        }

        // Process logs and find new ones
        let newLogs = deviceLogs.map((log, index) => {
            const timestamp = parseZktecoTime(log.record_time);
            const userId = log.user_id || log.userId || 'Unknown';
            return {
                id: `poll-${timestamp.getTime()}-${index}`,
                userId: userId,
                userName: findUserName(userId),
                timestamp: timestamp.toISOString(),
                verificationMethod: determineVerificationMethod(log),
                punchType: determinePunchType(log),
                deviceIp: DEVICE_IP,
                rawData: log,
                pollTime: timestamp
            };
        });

        // Filter only new records since last poll
        newLogs = newLogs.filter(log => log.pollTime > lastPolledTimestamp);
        
        // Sort by timestamp
        newLogs.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        if (newLogs.length > 0) {
            console.log(`🎯 [POLLING] Found ${newLogs.length} new attendance record(s) since last poll`);
            
            // Process each new record
            newLogs.forEach(log => {
                console.log(`\n🎯 [POLLED PUNCH] Detected via polling:`);
                console.log(`   👤 User: ${log.userName} (${log.userId})`);
                console.log(`   🕒 Time: ${new Date(log.timestamp).toLocaleTimeString()}`);
                console.log(`   📅 Date: ${new Date(log.timestamp).toLocaleDateString()}`);
                console.log(`   🔒 Method: ${log.verificationMethod}`);
                console.log(`   📝 Type: ${log.punchType}`);
                
                // Process this attendance record
                processAttendanceRecord(log);
            });

            // Update last polled timestamp to the latest record
            lastPolledTimestamp = new Date(Math.max(...newLogs.map(log => log.pollTime.getTime())));
        } else {
            console.log(`🔍 [POLLING] No new records found since last poll`);
        }

    } catch (error) {
        console.error('❌ [POLLING ERROR] Failed to poll attendance data:', error.message);
        
        // If device connection is lost, attempt to reconnect
        if (error.message.includes('timeout') || 
            error.message.includes('socket') || 
            error.message.includes('connection')) {
            console.log('🔄 [POLLING] Device connection issue detected, attempting to reconnect...');
            await reinitializeDeviceConnection();
        }
    } finally {
        isPollingInProgress = false;
    }
}

// ===== DEVICE RECONNECTION HANDLER =====
async function reinitializeDeviceConnection() {
    console.log('🔄 Attempting to reinitialize device connection...');
    
    if (deviceInstance) {
        try {
            deviceInstance.disconnect();
            console.log('📴 Disconnected from device');
        } catch (error) {
            console.log('⚠️ Error during device disconnect:', error.message);
        }
        deviceInstance = null;
    }
    
    // Reset connection attempts to allow reconnection
    connectionAttempts = 0;
    
    // Reinitialize after a short delay
    setTimeout(() => {
        console.log('🔄 Reinitializing device connection...');
        initializeDevice();
    }, 5000);
}

// ===== ATTENDANCE PROCESSING =====
function processAttendanceRecord(attendanceRecord) {
    console.log(`\n🎯 ===== PROCESSING ATTENDANCE RECORD =====`);
    console.log(`   👤 User: ${attendanceRecord.userName} (${attendanceRecord.userId})`);
    console.log(`   🕒 Time: ${new Date(attendanceRecord.timestamp).toLocaleTimeString()}`);
    console.log(`   📅 Date: ${new Date(attendanceRecord.timestamp).toLocaleDateString()}`);
    console.log(`   🔒 Method: ${attendanceRecord.verificationMethod}`);
    console.log(`   📝 Type: ${attendanceRecord.punchType}`);
    
    // ===== AUTO PUSH TO EXTERNAL API =====
    if (EXTERNAL_API_CONFIG.enabled) {
        if (RUSH_HANDLING_CONFIG.enabled) {
            const queueId = addToProcessingQueue(attendanceRecord);
            console.log(`🚀 [AUTO PUSH QUEUED] Added to processing queue`);
            console.log(`   📋 Queue ID: ${queueId}`);
            console.log(`   📊 Queue Length: ${pushQueue.length}`);
            
            io.emit('attendance_queued', {
                recordId: attendanceRecord.id,
                queueId: queueId,
                queueLength: pushQueue.length
            });
        } else {
            console.log('⚡ [DIRECT PUSH] Attempting direct push to external API...');
            pushToExternalAPI(attendanceRecord)
                .then(result => {
                    if (result.success) {
                        console.log(`✅ [DIRECT PUSH SUCCESS] Completed successfully`);
                        io.emit('external_api_push', {
                            recordId: attendanceRecord.id,
                            success: true,
                            message: 'Auto-pushed successfully',
                            payload: result.payload,
                            timestamp: new Date().toISOString()
                        });
                    } else {
                        console.error(`❌ [DIRECT PUSH FAILED] Error: ${result.error}`);
                    }
                })
                .catch(error => {
                    console.error('🚨 [DIRECT PUSH ERROR] Unexpected error:', error);
                });
        }
    } else {
        console.log('🌐 [AUTO PUSH SKIPPED] External API disabled in configuration');
    }
    
    // Add to history
    attendanceHistory.unshift(attendanceRecord);
    if (attendanceHistory.length > 1000) {
        attendanceHistory = attendanceHistory.slice(0, 1000);
    }
    
    // Broadcast to clients
    io.emit('attendance_record', attendanceRecord);
    io.emit('attendance_history', attendanceHistory);
    
    console.log('🎯 ===== ATTENDANCE PROCESSING COMPLETE =====\n');
}

// ===== REAL-TIME ATTENDANCE PROCESSING =====
async function processAndBroadcastAttendance(logData) {
    console.log('\n🎯 ===== REAL-TIME PUNCH DETECTED =====');
    console.log('📥 Raw device data:', JSON.stringify(logData, null, 2));
    
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
        rawData: logData
    };
    
    processAttendanceRecord(attendanceRecord);
}

// ===== API ROUTES =====

// Rush Handling Management
app.get('/api/rush-handling-status', (_req, res) => {
    res.json({
        enabled: RUSH_HANDLING_CONFIG.enabled,
        config: RUSH_HANDLING_CONFIG,
        stats: rushHandlingStats,
        queue: {
            length: pushQueue.length,
            concurrent: concurrentPushCount,
            isProcessing: isProcessingQueue
        }
    });
});

app.post('/api/rush-handling-control', (req, res) => {
    const { action, config } = req.body;
    
    try {
        switch (action) {
            case 'pause':
                isProcessingQueue = false;
                console.log('⏸️ Queue processing paused');
                break;
                
            case 'resume':
                if (!isProcessingQueue && pushQueue.length > 0) {
                    processQueue();
                }
                console.log('▶️ Queue processing resumed');
                break;
                
            case 'clear-queue':
                const clearedCount = pushQueue.length;
                pushQueue.length = 0;
                rushHandlingStats.queueLength = 0;
                console.log(`🗑️ Cleared ${clearedCount} items from queue`);
                break;
                
            case 'update-config':
                if (config) {
                    Object.assign(RUSH_HANDLING_CONFIG, config);
                    console.log('⚙️ Rush handling configuration updated');
                }
                break;
                
            default:
                return res.status(400).json({ error: 'Invalid action' });
        }
        
        res.json({
            success: true,
            message: `Action '${action}' completed`,
            stats: rushHandlingStats
        });
        
    } catch (error) {
        console.error('Error in rush handling control:', error);
        res.status(500).json({ error: error.message });
    }
});

// Device Information
app.get('/api/device-info', async (_req, res) => {
    if (!deviceInstance) return res.status(503).json({ error: 'Device not connected' });
    try {
        const formattedInfo = {
            'IP Address': DEVICE_IP,
            'Port': DEVICE_PORT,
            'Connection Status': 'Connected',
            'Real-time Monitoring': realTimeListenersActive ? 'Active' : 'Inactive',
            'Polling': POLLING_CONFIG.enabled ? 'Active' : 'Inactive',
            'Polling Status': isPollingInProgress ? 'In Progress' : 'Idle',
            'External API': EXTERNAL_API_CONFIG.enabled ? 'Enabled' : 'Disabled',
            'Rush Handling': RUSH_HANDLING_CONFIG.enabled ? 'Enabled' : 'Disabled',
            'Queue Status': `${pushQueue.length} items waiting`
        };
        res.status(200).json(formattedInfo);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch device information' });
    }
});

// User Management
app.get('/api/users', async (_req, res) => {
    if (!deviceInstance) return res.status(503).json({ error: 'Device not connected' });
    try {
        let users = await deviceInstance.getUsers();
        if (users && typeof users === 'object' && !Array.isArray(users)) {
            users = Object.values(users).find(val => Array.isArray(val)) || [];
        }
        users = Array.isArray(users) ? users : [];
        usersCache = users;
        res.status(200).json(users);
    } catch (error) {
        console.error('Error fetching users:', error.message);
        res.status(500).json({ error: 'Failed to fetch users from device: ' + error.message });
    }
});

// Attendance Management
app.get('/api/attendance', async (req, res) => {
    if (!deviceInstance) return res.status(503).json({ error: 'Device not connected' });
    try {
        const filterDate = req.query.date;
        let deviceLogs = await deviceInstance.getAttendances();
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
                verificationMethod: determineVerificationMethod(log),
                punchType: determinePunchType(log),
                deviceIp: DEVICE_IP,
                rawData: log
            };
        });
        if (filterDate) {
            processedLogs = processedLogs.filter(log => 
                new Date(log.timestamp).toISOString().split('T')[0] === filterDate
            );
        }
        processedLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        attendanceHistory = processedLogs;
        res.status(200).json({
            success: true,
            total: processedLogs.length,
            records: processedLogs,
            lastUpdated: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error fetching attendance:', error.message);
        res.status(500).json({ error: 'Failed to fetch attendance data: ' + error.message });
    }
});

// Manual Push Endpoint
app.post('/api/push-attendance', async (req, res) => {
    try {
        const { emp_code, punch_time, punch_date } = req.body;
        if (!emp_code || !punch_time) {
            return res.status(400).json({ error: 'emp_code and punch_time are required' });
        }
        
        const payload = { 
            emp_code, 
            punch_time,
            punch_date: punch_date || new Date().toISOString().split('T')[0]
        };
        
        console.log(`\n🔄 [MANUAL PUSH] Starting manual push:`);
        console.log(`   👤 Employee: ${emp_code}`);
        console.log(`   🕒 Time: ${punch_time}`);
        console.log(`   📅 Date: ${payload.punch_date}`);
        
        const response = await fetch(EXTERNAL_API_CONFIG.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(EXTERNAL_API_CONFIG.timeout)
        });

        const responseText = await response.text();
        let responseData;
        
        try {
            responseData = JSON.parse(responseText);
        } catch (e) {
            responseData = { raw_response: responseText };
        }
        
        console.log(`📡 [MANUAL PUSH RESPONSE] Status: ${response.status}`);
        console.log(`   Response:`, JSON.stringify(responseData, null, 2));
        
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        
        console.log(`✅ [MANUAL PUSH SUCCESS] Completed successfully`);
        
        res.status(200).json({
            success: true,
            message: 'Attendance pushed successfully',
            data: responseData,
            payload: payload
        });
    } catch (error) {
        console.error(`❌ [MANUAL PUSH FAILED] Error: ${error.message}`);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Force Poll Now
app.post('/api/poll-now', async (_req, res) => {
    try {
        console.log('\n🔍 [MANUAL POLL] Manual poll triggered via API');
        await pollForNewAttendances();
        res.json({
            success: true,
            message: 'Polling completed',
            queue_length: pushQueue.length,
            last_polled: lastPolledTimestamp,
            is_polling_in_progress: isPollingInProgress
        });
    } catch (error) {
        console.error('❌ Manual poll failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Reinitialize Device Connection
app.post('/api/reinitialize-device', async (_req, res) => {
    try {
        console.log('\n🔄 [MANUAL REINITIALIZE] Manual device reinitialization triggered');
        await reinitializeDeviceConnection();
        res.json({
            success: true,
            message: 'Device reinitialization triggered',
            reinitializing: true
        });
    } catch (error) {
        console.error('❌ Manual reinitialize failed:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Statistics
app.get('/api/push-statistics', (_req, res) => {
    res.json({
        external_api: EXTERNAL_API_CONFIG,
        push_statistics: pushStatistics,
        rush_handling: rushHandlingStats,
        polling: {
            enabled: POLLING_CONFIG.enabled,
            last_polled: lastPolledTimestamp,
            interval: POLLING_CONFIG.interval,
            is_in_progress: isPollingInProgress
        }
    });
});

// Diagnostic
app.get('/api/diagnostic', async (_req, res) => {
    const diagnostic = {
        server: { 
            status: 'running', 
            port: EXPRESS_PORT, 
            uptime: process.uptime(),
            node_version: process.version,
            platform: process.platform
        },
        device: { 
            connected: !!deviceInstance, 
            ip: DEVICE_IP, 
            port: DEVICE_PORT,
            real_time_active: realTimeListenersActive,
            connection_attempts: connectionAttempts
        },
        external_api: EXTERNAL_API_CONFIG,
        rush_handling: {
            enabled: RUSH_HANDLING_CONFIG.enabled,
            queue_length: pushQueue.length,
            concurrent_pushes: concurrentPushCount,
            stats: rushHandlingStats
        },
        polling: {
            enabled: POLLING_CONFIG.enabled,
            last_polled: lastPolledTimestamp,
            interval: POLLING_CONFIG.interval,
            is_in_progress: isPollingInProgress
        },
        data: { 
            users: usersCache.length, 
            attendance: attendanceHistory.length 
        }
    };
    res.json(diagnostic);
});

// Test Auto Push
app.post('/api/test-auto-push', (req, res) => {
    const { userId, userName } = req.body;
    
    const testRecord = {
        id: `test-${Date.now()}`,
        userId: userId || '250050',
        userName: userName || 'Test User',
        timestamp: new Date().toISOString(),
        punchType: 'Check-in',
        verificationMethod: 'Fingerprint',
        deviceIp: DEVICE_IP
    };
    
    console.log('\n🧪 [TEST AUTO PUSH] Simulating real-time punch:');
    console.log('   Record:', JSON.stringify(testRecord, null, 2));
    
    // Process the test record
    processAttendanceRecord(testRecord);
    
    res.json({
        success: true,
        message: 'Test record queued for auto push',
        record: testRecord,
        queue_length: pushQueue.length
    });
});

// Handle preflight requests
app.options('*', cors());

// ===== SOCKET.IO HANDLERS =====
io.on('connection', (socket) => {
    console.log('🔌 Client connected');
    
    socket.emit('users_data', usersCache);
    socket.emit('attendance_history', attendanceHistory);
    socket.emit('push_statistics', pushStatistics);
    
    if (deviceInstance) {
        deviceInstance.getInfo()
            .then(info => socket.emit('device_info', info))
            .catch(error => console.error('Error getting device info:', error));
    }

    socket.on('disconnect', () => {
        console.log('🔌 Client disconnected');
    });
});

// ===== ENHANCED DEVICE INITIALIZATION =====
async function initializeDevice() {
    try {
        if (connectionAttempts >= MAX_RETRIES) {
            console.log('Max connection attempts reached. Waiting 1 minute...');
            connectionAttempts = 0;
            setTimeout(initializeDevice, 60000);
            return;
        }

        console.log(`🔌 Attempting to connect to device at ${DEVICE_IP}:${DEVICE_PORT}...`);
        deviceInstance = new Zkteco(DEVICE_IP, DEVICE_PORT, CONNECTION_TIMEOUT);
        
        await Promise.race([
            deviceInstance.createSocket(),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Connection timeout')), CONNECTION_TIMEOUT)
            )
        ]);

        console.log(`✅ Connected to device at ${DEVICE_IP}:${DEVICE_PORT}`);
        console.log(`🌐 External API: ${EXTERNAL_API_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🚀 Rush Handling: ${RUSH_HANDLING_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);
        console.log(`🔍 Polling: ${POLLING_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);

        // Get device info
        try {
            const deviceInfo = await deviceInstance.getInfo();
            console.log('📊 Device Info:', deviceInfo);
        } catch (error) {
            console.error('❌ Error getting device info:', error.message);
        }

        // Get users
        try {
            const users = await deviceInstance.getUsers();
            if (users && typeof users === 'object' && !Array.isArray(users)) {
                usersCache = Object.values(users).find(val => Array.isArray(val)) || [];
            } else {
                usersCache = Array.isArray(users) ? users : [];
            }
            console.log(`👥 Total users on device: ${usersCache.length}`);
        } catch (error) {
            console.error('❌ Error loading users:', error.message);
        }

        // Set up real-time monitoring
        try {
            await deviceInstance.getRealTimeLogs((realTimeLog) => {
                console.log('\n🔔 ===== REAL-TIME PUNCH DETECTED FROM DEVICE =====');
                realTimeListenersActive = true;
                processAndBroadcastAttendance(realTimeLog);
            });
            console.log('👂 Listening for real-time attendance data...');
            realTimeListenersActive = true;
        } catch (error) {
            console.error('❌ Failed to setup real-time monitoring:', error.message);
            realTimeListenersActive = false;
            console.log('⚠️ Real-time monitoring disabled, relying on polling only');
        }

        // Set up polling as fallback
        if (POLLING_CONFIG.enabled) {
            console.log(`🔍 Setting up polling every ${POLLING_CONFIG.interval}ms`);
            
            // Clear any existing interval
            if (pollingInterval) {
                clearInterval(pollingInterval);
            }
            
            // Set up new polling interval
            pollingInterval = setInterval(async () => {
                try {
                    await pollForNewAttendances();
                } catch (error) {
                    console.error('❌ Polling interval error:', error.message);
                }
            }, POLLING_CONFIG.interval);
            
            // Do initial poll after a delay
            setTimeout(() => {
                console.log('🔍 Performing initial poll...');
                pollForNewAttendances();
            }, 3000);
        }

        connectionAttempts = 0;
        io.emit('device_connection', { 
            status: 'connected', 
            message: 'Device connected successfully',
            real_time_active: realTimeListenersActive,
            polling_active: POLLING_CONFIG.enabled
        });

    } catch (error) {
        console.error('❌ Failed to connect to device:', error.message);
        if (deviceInstance) {
            try {
                deviceInstance.disconnect();
            } catch (disconnectError) {
                console.log('⚠️ Error during device disconnect:', disconnectError.message);
            }
            deviceInstance = null;
        }
        connectionAttempts++;
        
        io.emit('device_connection', { 
            status: 'disconnected', 
            message: `Connection attempt ${connectionAttempts}/${MAX_RETRIES} failed: ${error.message}` 
        });
        
        const retryDelay = Math.min(5000 * connectionAttempts, 30000); // Exponential backoff max 30s
        console.log(`Retrying in ${retryDelay/1000} seconds... (${connectionAttempts}/${MAX_RETRIES})`);
        setTimeout(initializeDevice, retryDelay);
    }
}

// ===== SERVER STARTUP =====
server.listen(EXPRESS_PORT, () => {
    console.log(`🚀 HR System running on port ${EXPRESS_PORT}`);
    console.log(`📱 Dashboard: http://localhost:${EXPRESS_PORT}`);
    console.log(`🔗 Device: ${DEVICE_IP}:${DEVICE_PORT}`);
    console.log(`🌐 External API: ${EXTERNAL_API_CONFIG.enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🚀 Auto Push: ${EXTERNAL_API_CONFIG.enabled ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`🔍 Polling: ${POLLING_CONFIG.enabled ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`📊 Test Auto Push: POST http://localhost:${EXPRESS_PORT}/api/test-auto-push`);
    console.log(`🔍 Manual Poll: POST http://localhost:${EXPRESS_PORT}/api/poll-now`);
    console.log(`🔄 Reinitialize Device: POST http://localhost:${EXPRESS_PORT}/api/reinitialize-device`);
    console.log(`🐛 Debug Endpoints:`);
    console.log(`   - POST http://localhost:${EXPRESS_PORT}/api/debug-push-payload`);
    console.log(`   - POST http://localhost:${EXPRESS_PORT}/api/test-external-api`);
    
    // Increase max listeners to prevent warnings (ES modules compatible)
    EventEmitter.defaultMaxListeners = 20;
    process.setMaxListeners(20);
    
    initializeDevice();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down server...');
    isProcessingQueue = false;
    
    // Clear polling interval
    if (pollingInterval) {
        clearInterval(pollingInterval);
    }
    
    if (deviceInstance) {
        try {
            deviceInstance.disconnect();
            console.log('📴 Disconnected from device');
        } catch (error) {
            console.log('⚠️ Error during device disconnect:', error.message);
        }
    }
    
    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('🚨 Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('🚨 Unhandled Rejection at:', promise, 'reason:', reason);
});