const http = require('http');

// Prinect API Configuration
const PRINECT_API_CONFIG = {
    host: '192.168.3.10',
    port: 15011,
    basePath: '/PrinectAPILocal/rest',
    username: 'shubhi',
    password: 'vkgp_123'
};

// Valid device IDs for printing worksteps
const VALID_DEVICE_IDS = [7001, 7003, 7004, 7005, 7007, 7008, 7009, 8001];

// Device ID to Name mapping
const DEVICE_NAMES = {
    7001: 'CD102_6L',
    7003: 'CD102_4L',
    7004: 'SM74_4',
    7005: 'SM74_5',
    7007: 'CD102_4',
    7008: 'SM102_2',
    7009: 'CX75_6L',
    8001: 'CD102_2'
};

// Get device name from ID
function getDeviceName(deviceId) {
    return DEVICE_NAMES[deviceId] || `Device ${deviceId}`;
}

// Create Basic Auth header
function getPrinectAuthHeader() {
    const credentials = Buffer.from(`${PRINECT_API_CONFIG.username}:${PRINECT_API_CONFIG.password}`).toString('base64');
    return `Basic ${credentials}`;
}

// Make request to Prinect API
function makePrinectApiRequest(apiPath) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: PRINECT_API_CONFIG.host,
            port: PRINECT_API_CONFIG.port,
            path: `${PRINECT_API_CONFIG.basePath}${apiPath}`,
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': getPrinectAuthHeader()
            }
        };

        console.log(`[Prinect] Making API request to: http://${options.hostname}:${options.port}${options.path}`);

        const req = http.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                console.log(`[Prinect] Response status: ${res.statusCode}`);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const jsonData = JSON.parse(data);
                        resolve(jsonData);
                    } catch (e) {
                        console.log('[Prinect] Raw response:', data);
                        reject(new Error('Invalid JSON response from Prinect API'));
                    }
                } else {
                    reject(new Error(`Prinect API returned status ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', (error) => {
            console.error('[Prinect] Request error:', error);
            reject(error);
        });

        req.setTimeout(30000, () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });

        req.end();
    });
}

// Setup Prinect routes on Express app
function setupPrinectRoutes(app) {
    const path = require('path');
    
    // Serve Prinect static files
    app.use('/prinect', require('express').static(path.join(__dirname, 'prinect')));
    
    // Serve Prinect index.html at /prinect
    app.get('/prinect', (req, res) => {
        res.sendFile(path.join(__dirname, 'prinect', 'index.html'));
    });

    // Prinect API: Get worksteps for a job
    app.get('/api/prinect/worksteps/:jobId', async (req, res) => {
        try {
            const { jobId } = req.params;
            if (!jobId) {
                return res.status(400).json({ error: 'Job ID is required' });
            }

            const data = await makePrinectApiRequest(`/job/${jobId}/workstep/`);
            res.json(data);
        } catch (error) {
            console.error('[Prinect] Error fetching worksteps:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Prinect API: Get ink consumption for a workstep
    app.get('/api/prinect/ink/:jobId/:workstepId', async (req, res) => {
        try {
            const { jobId, workstepId } = req.params;
            if (!jobId || !workstepId) {
                return res.status(400).json({ error: 'Job ID and Workstep ID are required' });
            }

            const data = await makePrinectApiRequest(`/job/${jobId}/workstep/${workstepId}/inkConsumption`);
            res.json(data);
        } catch (error) {
            console.error('[Prinect] Error fetching ink consumption:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Debug endpoint: Get raw ink consumption data for a job
    app.get('/api/prinect/debug/:jobId', async (req, res) => {
        try {
            const { jobId } = req.params;
            if (!jobId) {
                return res.status(400).json({ error: 'Job ID is required' });
            }

            console.log(`[Prinect DEBUG] Fetching raw data for job: ${jobId}`);

            // Get worksteps
            const workstepsData = await makePrinectApiRequest(`/job/${jobId}/workstep/`);
            
            let worksteps = workstepsData.workstep || workstepsData.worksteps || workstepsData;
            if (!Array.isArray(worksteps)) {
                worksteps = [worksteps];
            }

            // Fetch ink for ALL worksteps (not just valid device IDs)
            const allInkData = [];
            for (const ws of worksteps) {
                const wsId = ws.id || ws.workstepId || ws.Id;
                const deviceId = ws.deviceId || ws.device?.id || ws.deviceID || ws.DeviceId;
                
                try {
                    const inkData = await makePrinectApiRequest(`/job/${jobId}/workstep/${wsId}/inkConsumption`);
                    allInkData.push({
                        workstepId: wsId,
                        deviceId: deviceId,
                        deviceName: getDeviceName(Number(deviceId)),
                        rawInkResponse: inkData
                    });
                } catch (err) {
                    allInkData.push({
                        workstepId: wsId,
                        deviceId: deviceId,
                        error: err.message
                    });
                }
            }

            res.json({
                jobId: jobId,
                rawWorkstepsResponse: workstepsData,
                workstepCount: worksteps.length,
                inkDataPerWorkstep: allInkData
            });
        } catch (error) {
            console.error('[Prinect DEBUG] Error:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    // Prinect API: Get full ink consumption (worksteps + ink data combined)
    app.get('/api/prinect/full-ink/:jobId', async (req, res) => {
        try {
            const { jobId } = req.params;
            if (!jobId) {
                return res.status(400).json({ error: 'Job ID is required' });
            }

            console.log(`[Prinect] Fetching full ink data for job: ${jobId}`);

            // Step 1: Get worksteps
            const workstepsData = await makePrinectApiRequest(`/job/${jobId}/workstep/`);
            console.log('[Prinect] Worksteps data:', JSON.stringify(workstepsData, null, 2));

            // Extract worksteps array
            let worksteps = workstepsData.workstep || workstepsData.worksteps || workstepsData;
            if (!Array.isArray(worksteps)) {
                worksteps = [worksteps];
            }

            // Step 2: Filter by valid device IDs
            const validWorksteps = worksteps.filter(ws => {
                const deviceId = ws.deviceId || ws.device?.id || ws.deviceID || ws.DeviceId;
                console.log(`[Prinect] Workstep ${ws.id}: deviceId = ${deviceId}`);
                return VALID_DEVICE_IDS.includes(Number(deviceId));
            }).map(ws => {
                // Add device name to workstep
                const deviceId = ws.deviceId || ws.device?.id || ws.deviceID || ws.DeviceId;
                return {
                    ...ws,
                    deviceName: getDeviceName(Number(deviceId))
                };
            });

            console.log(`[Prinect] Found ${validWorksteps.length} valid worksteps out of ${worksteps.length}`);

            if (validWorksteps.length === 0) {
                return res.json({ 
                    success: true,
                    jobId: jobId,
                    message: 'No printing worksteps found with valid device IDs',
                    validDeviceIds: VALID_DEVICE_IDS,
                    allWorksteps: worksteps,
                    inkData: []
                });
            }

            // Step 3: Fetch ink consumption for each valid workstep
            const allInkData = [];
            for (const workstep of validWorksteps) {
                const workstepId = workstep.id || workstep.workstepId || workstep.Id;
                try {
                    const inkData = await makePrinectApiRequest(`/job/${jobId}/workstep/${workstepId}/inkConsumption`);
                    console.log(`[Prinect] Raw ink data for workstep ${workstepId}:`, JSON.stringify(inkData, null, 2));
                    
                    // Handle various nested structures from Prinect API
                    let inkConsumptionArray = [];
                    
                    if (inkData.inkConsumption && inkData.inkConsumption.inkConsumptions) {
                        // Structure: { inkConsumption: { inkConsumptions: [...] } }
                        inkConsumptionArray = inkData.inkConsumption.inkConsumptions;
                    } else if (inkData.inkConsumptions) {
                        // Structure: { inkConsumptions: [...] }
                        inkConsumptionArray = inkData.inkConsumptions;
                    } else if (inkData.inkConsumption && Array.isArray(inkData.inkConsumption)) {
                        // Structure: { inkConsumption: [...] }
                        inkConsumptionArray = inkData.inkConsumption;
                    } else if (Array.isArray(inkData)) {
                        // Structure: [...]
                        inkConsumptionArray = inkData;
                    } else if (inkData.inkConsumption && typeof inkData.inkConsumption === 'object') {
                        // Structure: { inkConsumption: { color1: {...}, color2: {...} } } - object with color keys
                        // Or single ink object: { inkConsumption: { color: "Black", estimatedConsumption: 123 } }
                        const inkObj = inkData.inkConsumption;
                        if (inkObj.color || inkObj.colorName || inkObj.estimatedConsumption !== undefined) {
                            // Single ink object
                            inkConsumptionArray = [inkObj];
                        } else {
                            // Object with multiple color keys
                            inkConsumptionArray = Object.values(inkObj);
                        }
                    } else if (inkData.color || inkData.colorName || inkData.estimatedConsumption !== undefined) {
                        // Structure: { color: "Black", estimatedConsumption: 123 } - single ink at root
                        inkConsumptionArray = [inkData];
                    }
                    
                    // Ensure it's always an array
                    if (!Array.isArray(inkConsumptionArray)) {
                        inkConsumptionArray = inkConsumptionArray ? [inkConsumptionArray] : [];
                    }
                    
                    console.log(`[Prinect] Extracted ${inkConsumptionArray.length} ink colors:`, inkConsumptionArray.map(i => i.color || i.colorName || 'unknown'));
                    
                    allInkData.push({
                        workstep: workstep,
                        inkConsumption: inkConsumptionArray,
                        rawResponse: inkData
                    });
                    console.log(`[Prinect] Got ink data for workstep ${workstepId}: ${inkConsumptionArray.length} colors`);
                } catch (err) {
                    console.warn(`[Prinect] Failed to fetch ink for workstep ${workstepId}:`, err.message);
                }
            }

            res.json({
                success: true,
                jobId: jobId,
                totalWorksteps: worksteps.length,
                validWorksteps: validWorksteps.length,
                inkData: allInkData
            });
        } catch (error) {
            console.error('[Prinect] Error fetching full ink data:', error.message);
            res.status(500).json({ error: error.message });
        }
    });

    console.log('✅ Prinect routes registered:');
    console.log('   GET  /prinect - Prinect Ink Tracker UI');
    console.log('   GET  /api/prinect/worksteps/:jobId');
    console.log('   GET  /api/prinect/ink/:jobId/:workstepId');
    console.log('   GET  /api/prinect/full-ink/:jobId');
}

module.exports = { setupPrinectRoutes };

