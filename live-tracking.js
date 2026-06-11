// ============================================================================
// Live Tracking client (used by data-entry.js)
// ----------------------------------------------------------------------------
// Sends operator login/logout, job load/unload and machine state changes to the
// server so a central live dashboard can be built. All calls are best-effort
// (fire-and-forget): a failed request logs a warning but never blocks or breaks
// the existing production workflow.
// ============================================================================
(function (global) {
    const API_BASE = `${global.location.protocol}//${global.location.host}/api/live`;

    // Stable per-device id (helps trace which terminal logged a session).
    function getDeviceId() {
        try {
            let id = localStorage.getItem('vk_device_id');
            if (!id) {
                id = 'dev-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
                localStorage.setItem('vk_device_id', id);
            }
            return id;
        } catch (e) {
            return null;
        }
    }

    let ctx = {
        machineId: null,
        machineName: null,
        category: null,
        process: null,
        deviceId: getDeviceId()
    };

    async function post(pathname, body) {
        try {
            const res = await fetch(`${API_BASE}/${pathname}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {})
            });
            const data = await res.json().catch(() => null);
            if (!res.ok || (data && data.success === false)) {
                console.warn(`[LiveTracking] ${pathname} failed:`, data && data.error);
            }
            return data;
        } catch (err) {
            console.warn(`[LiveTracking] ${pathname} request error:`, err && err.message);
            return null;
        }
    }

    const LiveTracking = {
        // Set machine identity once the page knows which machine it is.
        configure(partial) {
            ctx = Object.assign({}, ctx, partial || {});
            if (!ctx.deviceId) ctx.deviceId = getDeviceId();
            return ctx;
        },

        isConfigured() {
            return !!ctx.machineId;
        },

        // Operator selected this machine for the shift.
        login(operator) {
            if (!ctx.machineId || !operator) return Promise.resolve(null);
            return post('login', {
                machineId: ctx.machineId,
                machineName: ctx.machineName,
                category: ctx.category,
                process: ctx.process,
                operator,
                deviceId: ctx.deviceId
            });
        },

        // Operator ends the shift (manual button). reason defaults to 'manual'.
        logout(reason) {
            if (!ctx.machineId) return Promise.resolve(null);
            return post('logout', { machineId: ctx.machineId, reason: reason || 'manual' });
        },

        // A job was loaded onto the machine.
        // job = { po, jobName, fgNum, plannedQty }
        jobLoad(job) {
            if (!ctx.machineId) return Promise.resolve(null);
            return post('job-load', {
                machineId: ctx.machineId,
                machineName: ctx.machineName,
                po: job && (job.po || job.poNumber || job.jobNumber) || null,
                jobName: job && (job.jobName || job.name) || null,
                fgNum: job && (job.fgNum || job.fgItemCode || job.itemNo) || null,
                plannedQty: job && (job.plannedQty != null ? job.plannedQty : job.plannedQuantity) || null
            });
        },

        // Job finished / unloaded.
        jobUnload() {
            if (!ctx.machineId) return Promise.resolve(null);
            return post('job-unload', { machineId: ctx.machineId });
        },

        // Machine state change (e.g. running, downtime_mech, lunch, idle).
        setState(state) {
            if (!ctx.machineId || !state) return Promise.resolve(null);
            return post('state', { machineId: ctx.machineId, machineName: ctx.machineName, state });
        }
    };

    global.LiveTracking = LiveTracking;
})(window);
