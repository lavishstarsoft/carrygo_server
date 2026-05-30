const Driver = require('../models/Driver');
const Notification = require('../models/Notification');
const path = require('path');
const { redis } = require('../config/redis');

const getAllDrivers = async (req, res) => {
    try {
        const data = await Driver.find({});
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const createDriver = async (req, res) => {
    const { name, phone, vehicle_type, vehicle_number } = req.body;
    try {
        const data = await Driver.create({ name, phone, vehicle_type, vehicle_number });
        
        const io = req.app.get('io');
        if (io) io.emit('fleet_updated', data);
        
        return res.status(201).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const updateDriver = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await Driver.findByIdAndUpdate(id, req.body, { new: true });
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        
        const io = req.app.get('io');
        if (io) io.emit('fleet_updated', data);
        
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const getDriverById = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await Driver.findById(id);
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const deleteDriver = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await Driver.findByIdAndDelete(id);
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        
        const io = req.app.get('io');
        if (io) io.emit('fleet_updated', { _id: id, deleted: true });
        
        return res.status(200).json({ message: 'Driver deleted successfully' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

const updateDriverLocation = async (req, res) => {
    const { id } = req.params;
    const { latitude, longitude } = req.body;
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            {
                latitude,
                longitude,
                location: {
                    type: 'Point',
                    coordinates: [longitude, latitude], // GeoJSON: [lng, lat]
                },
            },
            { new: true }
        );
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        // --- SCALE SYNC: Update Redis Geolocation Index ---
        // We only index drivers who are active and not on a trip for better efficiency
        if (data.is_active && !data.is_on_trip && !data.is_blocked && data.kyc_status?.match(/approved/i)) {
            try {
                // Key: drivers_locations, Member: driver_id
                await redis.geoadd('drivers_locations', longitude, latitude, id);
            } catch (redisErr) {
                console.error('❌ [Redis GEOADD Error]:', redisErr.message);
            }
        } else {
            // Remove from index if they become unavailable
            try {
                await redis.zrem('drivers_locations', id);
            } catch (redisErr) {}
        }

        // Emit real-time location if driver is on a trip
        if (data.is_on_trip && data.current_order_id) {
            const io = req.app.get('io');
            if (io) {
                io.emit(`driver_location_${data.current_order_id}`, {
                    latitude,
                    longitude,
                    driver_id: id,
                });
            }
        }

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Personal Details Update
const updatePersonalDetails = async (req, res) => {
    const { id } = req.params;
    const { name } = req.body;
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            { name },
            { new: true }
        );
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Vehicle Details Update
const updateVehicleDetails = async (req, res) => {
    const { id } = req.params;
    const { city, vehicle_type, vehicle_number, vehicle_body_type, vehicle_fuel_type, ...advancedInfo } = req.body;
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            { city, vehicle_type, vehicle_number, vehicle_body_type, vehicle_fuel_type, vehicle_advanced_info: advancedInfo },
            { new: true }
        );
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Driver Details Update (Step 3)
const updateDriverDetails = async (req, res) => {
    const { id } = req.params;
    const { driver_is_self, driver_name, driver_phone } = req.body;
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            { driver_is_self, driver_name, driver_phone },
            { new: true }
        );
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// KYC Document Upload
const uploadKYCDocuments = async (req, res) => {
    const { id } = req.params;
    const { vehicleId } = req.query; // Check if uploading for a specific vehicle
    try {
        const updates = {};
        const publicDomain = process.env.R2_PUBLIC_DOMAIN || 'https://pub-c5bb8646137a4466b52b250a41f3fa75.r2.dev';

        const docFieldsMapping = {
            'doc_aadhaar_front': 'aadhaar_front',
            'doc_aadhaar_back': 'aadhaar_back',
            'doc_pan_front': 'pan_front',
            'doc_pan_back': 'pan_back',
            'doc_license_front': 'license_front',
            'doc_license_back': 'license_back',
            'doc_rc_front': 'rc_front',
            'doc_rc_back': 'rc_back',
            'doc_insurance': 'insurance',
            'doc_selfie': 'selfie'
        };

        for (const [formField, dbField] of Object.entries(docFieldsMapping)) {
            if (req.files && req.files[formField] && req.files[formField][0]) {
                const fileKey = req.files[formField][0].key;
                updates[dbField] = `${publicDomain}/${fileKey}`;
                console.log(`[KYC Upload] ${dbField} uploaded for ${id}: ${fileKey}`);
            }
        }

        if (Object.keys(updates).length === 0) {
            return res.status(200).json({ message: 'No files to upload' });
        }

        const driver = await Driver.findById(id);
        if (!driver) return res.status(404).json({ error: 'Driver not found' });

        if (vehicleId) {
            // Update specific vehicle in array
            const vehicle = driver.vehicles.id(vehicleId);
            if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

            for (const [dbField, value] of Object.entries(updates)) {
                if (vehicle[dbField] !== undefined) {
                    vehicle[dbField] = value;
                }
            }

            // Sync top-level fields if this is the "active" vehicle (matching vehicle_number)
            if (vehicle.vehicle_number === driver.vehicle_number) {
                Object.assign(driver, updates);
            }

            // Handle resolution of kyc_issues for this vehicle
            if (vehicle.kyc_status === 'action_required') {
                const uploadedFields = Object.keys(updates);
                vehicle.kyc_issues = (vehicle.kyc_issues || []).filter(issue => !uploadedFields.includes(issue.document));
                if (vehicle.kyc_issues.length === 0) {
                    vehicle.kyc_status = 'pending';
                }
            }

            await driver.save();
            return res.status(200).json(driver);
        } else {
            // Standard top-level update
            Object.assign(driver, updates);

            if (driver.kyc_status === 'action_required') {
                const uploadedFields = Object.keys(updates);
                driver.kyc_issues = (driver.kyc_issues || []).filter(issue => !uploadedFields.includes(issue.document));
                if (driver.kyc_issues.length === 0) {
                    driver.kyc_status = 'pending';
                    driver.kyc_issue_document = '';
                    driver.kyc_issue_reason = '';
                } else {
                    driver.kyc_issue_document = driver.kyc_issues[0].document;
                    driver.kyc_issue_reason = driver.kyc_issues[0].reason;
                }
            }

            await driver.save();
            return res.status(200).json(driver);
        }
    } catch (error) {
        console.error('[KYC Upload] Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Submit KYC (mark as pending review)
const submitKYC = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            { kyc_status: 'pending' },
            { new: true }
        );
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        // Create Notification for Admin
        const notification = await Notification.create({
            title: 'New Driver Registration',
            message: `${data.name || 'A driver'} has submitted their KYC details for review.`,
            type: 'driver_registered',
            relatedId: data._id,
            onModel: 'Driver'
        });

        // Emit real-time socket event
        const io = req.app.get('io');
        if (io) {
            io.emit('new_notification', notification);
        }

        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Get pending KYC requests (for Admin)
const getPendingKYC = async (req, res) => {
    try {
        const data = await Driver.find({ kyc_status: 'pending' });
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Get single driver KYC details (for Admin)
const getDriverKYC = async (req, res) => {
    const { id } = req.params;
    try {
        const data = await Driver.findById(id);
        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }
        return res.status(200).json(data);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Approve KYC (Admin)
const approveKYC = async (req, res) => {
    const { id } = req.params;
    const { vehicleId } = req.query;
    try {
        let data;
        if (vehicleId) {
            data = await Driver.findOneAndUpdate(
                { _id: id, "vehicles._id": vehicleId },
                {
                    $set: {
                        "vehicles.$.kyc_status": 'approved',
                        "vehicles.$.kyc_issues": []
                    }
                },
                { new: true }
            );

            // Sync with top-level if this is the active vehicle
            if (data && data.vehicle_number === data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number) {
                data = await Driver.findByIdAndUpdate(id, { kyc_status: 'approved', kyc_issues: [] }, { new: true });
            }
        } else {
            data = await Driver.findByIdAndUpdate(
                id,
                { kyc_status: 'approved', kyc_issues: [] },
                { new: true }
            );
        }

        if (!data) return res.status(404).json({ error: 'Driver or Vehicle not found' });

        const notification = await Notification.create({
            title: 'KYC Approved',
            message: vehicleId ? `Your vehicle (${data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number}) has been approved!` : 'Your background verification is complete. You are now ready to deliver!',
            type: 'kyc_approved',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.to(`driver_${id}`).emit('kyc_status_update', { status: 'approved', vehicleId, notification });
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error('approveKYC error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Reject KYC (Admin)
const rejectKYC = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const { vehicleId } = req.query;
    try {
        const rejectionReason = reason || 'Documents not valid';
        let data;

        if (vehicleId) {
            data = await Driver.findOneAndUpdate(
                { _id: id, "vehicles._id": vehicleId },
                {
                    $set: {
                        "vehicles.$.kyc_status": 'rejected',
                        "vehicles.$.kyc_issues": [{ document: 'vehicle', reason: rejectionReason }] // generic vehicle issue
                    }
                },
                { new: true }
            );
            // Sync with top-level if active vehicle
            if (data && data.vehicle_number === data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number) {
                data = await Driver.findByIdAndUpdate(id, { kyc_status: 'rejected', kyc_rejection_reason: rejectionReason }, { new: true });
            }
        } else {
            data = await Driver.findByIdAndUpdate(
                id,
                { kyc_status: 'rejected', kyc_rejection_reason: rejectionReason },
                { new: true }
            );
        }

        if (!data) return res.status(404).json({ error: 'Driver or Vehicle not found' });

        const notification = await Notification.create({
            title: 'KYC Rejected',
            message: vehicleId ? `Verification for vehicle ${data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number} was rejected.` : `Your KYC was rejected. Reason: ${rejectionReason}`,
            type: 'kyc_rejected',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.to(`driver_${id}`).emit('kyc_status_update', { status: 'rejected', reason: rejectionReason, vehicleId, notification });
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error('rejectKYC error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Request Targeted Re-Upload (Admin) — supports single or multiple documents
const requestKYCReUpload = async (req, res) => {
    const { id } = req.params;
    const { vehicleId } = req.query;
    let issues = [];

    if (req.body.documents && Array.isArray(req.body.documents)) {
        issues = req.body.documents;
    } else if (req.body.documentName && req.body.reason) {
        issues = [{ document: req.body.documentName, reason: req.body.reason }];
    }

    try {
        if (issues.length === 0) {
            return res.status(400).json({ error: 'At least one document with a reason is required' });
        }

        let data;
        if (vehicleId) {
            data = await Driver.findOneAndUpdate(
                { _id: id, "vehicles._id": vehicleId },
                {
                    $set: {
                        "vehicles.$.kyc_status": 'action_required',
                        "vehicles.$.kyc_issues": issues
                    }
                },
                { new: true }
            );
            // Sync with top-level if active vehicle
            if (data && data.vehicle_number === data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number) {
                data = await Driver.findByIdAndUpdate(id, {
                    kyc_status: 'action_required',
                    kyc_issues: issues,
                    kyc_issue_document: issues[0].document,
                    kyc_issue_reason: issues[0].reason,
                }, { new: true });
            }
        } else {
            data = await Driver.findByIdAndUpdate(
                id,
                {
                    kyc_status: 'action_required',
                    kyc_issues: issues,
                    kyc_issue_document: issues[0].document,
                    kyc_issue_reason: issues[0].reason,
                },
                { new: true }
            );
        }

        if (!data) return res.status(404).json({ error: 'Driver or Vehicle not found' });

        const docNames = issues.map(i => i.document.replace(/_/g, ' ')).join(', ');
        const notification = await Notification.create({
            title: 'Action Required: Update KYC',
            message: vehicleId ? `Please re-upload documents for vehicle ${data.vehicles.find(v => v._id.toString() === vehicleId)?.vehicle_number}: ${docNames}` : `Please re-upload: ${docNames}`,
            type: 'kyc_action_required',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.emit(`kyc_status_update_${id}`, {
                status: 'action_required',
                documents: issues,
                vehicleId,
                notification
            });
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error('requestKYCReUpload error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Block Driver
const blockDriver = async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    try {
        const driver = await Driver.findByIdAndUpdate(
            id,
            { is_blocked: true, block_reason: reason || 'Violation of terms' },
            { new: true }
        );

        if (!driver) return res.status(404).json({ error: 'Driver not found' });

        // Create Notification record for the driver
        const notification = await Notification.create({
            title: 'Account Suspended',
            message: `Your account has been suspended by the admin. Reason: ${driver.block_reason}`,
            type: 'account_blocked',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.emit(`driver_block_status_${id}`, { is_blocked: true, reason: driver.block_reason, notification });
        }

        return res.status(200).json({ message: 'Driver blocked successfully', driver });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Unblock Driver
const unblockDriver = async (req, res) => {
    const { id } = req.params;
    try {
        const driver = await Driver.findByIdAndUpdate(
            id,
            { is_blocked: false, block_reason: '' },
            { new: true }
        );

        if (!driver) return res.status(404).json({ error: 'Driver not found' });

        // Create Notification record for the driver
        const notification = await Notification.create({
            title: 'Account Reactivated',
            message: 'Your account has been reactivated by the admin. You can now resume your deliveries.',
            type: 'account_unblocked',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.to(`driver_${id}`).emit('driver_block_status', { is_blocked: false, notification });
        }

        return res.status(200).json({ message: 'Driver unblocked successfully', driver });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Reset KYC to Pending (Admin)
const resetToPending = async (req, res) => {
    const { id } = req.params;
    console.log(`[Admin] Resetting driver ${id} to pending status...`);
    try {
        const data = await Driver.findByIdAndUpdate(
            id,
            {
                kyc_status: 'pending',
                is_active: false,
                kyc_issues: [],
                kyc_rejection_reason: '',
                kyc_issue_document: '',
                kyc_issue_reason: ''
            },
            { new: true, returnDocument: 'after' }
        );

        if (!data) {
            console.error(`[Admin] Reset failed: Driver ${id} not found`);
            return res.status(404).json({ error: 'Driver not found' });
        }

        console.log(`[Admin] Driver ${id} status reset to pending. New status: ${data.kyc_status}`);

        // Create Notification record for the driver
        const notification = await Notification.create({
            title: 'KYC Status Reset',
            message: 'Your KYC application is back under review. Please wait for further updates.',
            type: 'kyc_status_reset',
            relatedId: id,
            onModel: 'Driver'
        });

        // Notify that specific driver
        const io = req.app.get('io');
        if (io) {
            io.to(`driver_${id}`).emit('kyc_status_update', { status: 'pending', notification });
        }

        return res.status(200).json(data);
    } catch (error) {
        console.error('resetToPending error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

const addVehicle = async (req, res) => {
    const { id } = req.params;
    const { city, vehicle_type, vehicle_number, vehicle_body_type, vehicle_fuel_type, ...advancedInfo } = req.body;
    try {
        const vehicleData = {
            vehicle_type,
            vehicle_number,
            vehicle_body_type,
            vehicle_fuel_type,
            vehicle_advanced_info: advancedInfo,
            kyc_status: 'pending',
            createdAt: new Date()
        };

        const data = await Driver.findByIdAndUpdate(
            id,
            {
                $push: { vehicles: vehicleData },
                // For compatibility with current job matching, update top-level fields
                city,
                vehicle_type,
                vehicle_number,
                vehicle_body_type,
                vehicle_fuel_type,
                vehicle_advanced_info: advancedInfo,
                kyc_status: 'pending'
            },
            { new: true }
        );

        if (!data) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        // Notify Admin
        const notification = await Notification.create({
            title: 'New Vehicle Added',
            message: `${data.name || 'A driver'} has added a new vehicle: ${vehicle_number}`,
            type: 'driver_registered',
            relatedId: id,
            onModel: 'Driver'
        });

        const io = req.app.get('io');
        if (io) {
            io.emit('new_notification', notification);
        }

        const newVehicleId = data.vehicles[data.vehicles.length - 1]._id;
        return res.status(200).json({ driver: data, newVehicleId });
    } catch (error) {
        console.error('addVehicle error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

// Selfie Upload compatibility endpoint
const uploadSelfie = async (req, res) => {
    const { id } = req.params;
    try {
        const publicDomain = process.env.R2_PUBLIC_DOMAIN || 'https://pub-c5bb8646137a4466b52b250a41f3fa75.r2.dev';
        let selfieKey = null;

        if (req.file) {
            selfieKey = req.file.key;
        } else if (req.files) {
            if (req.files['selfie'] && req.files['selfie'][0]) {
                selfieKey = req.files['selfie'][0].key;
            } else if (req.files['doc_selfie'] && req.files['doc_selfie'][0]) {
                selfieKey = req.files['doc_selfie'][0].key;
            }
        }

        if (!selfieKey) {
            return res.status(400).json({ error: 'No selfie file uploaded' });
        }

        const selfieUrl = `${publicDomain}/${selfieKey}`;
        const driver = await Driver.findByIdAndUpdate(
            id,
            { selfie: selfieUrl },
            { new: true }
        );

        if (!driver) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        console.log(`[KYC Upload] Selfie uploaded for ${id}: ${selfieKey}`);
        return res.status(200).json(driver);
    } catch (error) {
        console.error('[Selfie Upload] Error:', error.message);
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getAllDrivers,
    getDriverById,
    createDriver,
    updateDriver,
    deleteDriver,
    updateDriverLocation,
    updatePersonalDetails,
    updateVehicleDetails,
    updateDriverDetails,
    uploadKYCDocuments,
    submitKYC,
    getPendingKYC,
    getDriverKYC,
    approveKYC,
    rejectKYC,
    requestKYCReUpload,
    blockDriver,
    unblockDriver,
    resetToPending,
    addVehicle,
    uploadSelfie
};

