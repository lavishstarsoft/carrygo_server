const express = require('express');
const router = express.Router();
const multer = require('multer');
const multerS3 = require('multer-s3');
const path = require('path');
const driverController = require('../controllers/driverController');
const { s3Client, bucketName } = require('../config/r2');

// Multer storage configuration — Cloudflare R2 via S3 API
const storage = multerS3({
    s3: s3Client,
    bucket: bucketName,
    contentType: multerS3.AUTO_CONTENT_TYPE,
    key: (req, file, cb) => {
        const uniqueName = `drivers/${Date.now()}-${Math.round(Math.random() * 1E9)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    },
});

const upload = multer({ storage });

// Document fields for multer (matching frontend FormData keys)
const docFields = [
    { name: 'doc_aadhaar_front', maxCount: 1 },
    { name: 'doc_aadhaar_back', maxCount: 1 },
    { name: 'doc_pan_front', maxCount: 1 },
    { name: 'doc_pan_back', maxCount: 1 },
    { name: 'doc_license_front', maxCount: 1 },
    { name: 'doc_license_back', maxCount: 1 },
    { name: 'doc_rc_front', maxCount: 1 },
    { name: 'doc_rc_back', maxCount: 1 },
    { name: 'doc_insurance', maxCount: 1 },
    { name: 'doc_selfie', maxCount: 1 }, // Handled together in one call
];

// Public routes
router.get('/', driverController.getAllDrivers);
router.post('/', driverController.createDriver);
router.get('/:id', driverController.getDriverById);
router.put('/:id', driverController.updateDriver);
router.delete('/:id', driverController.deleteDriver);
router.put('/:id/location', driverController.updateDriverLocation);

// KYC routes
router.put('/:id/kyc-personal', driverController.updatePersonalDetails);
router.put('/:id/kyc-vehicle', driverController.updateVehicleDetails);
router.put('/:id/kyc-driver', driverController.updateDriverDetails);
router.put('/:id/kyc-documents', upload.fields(docFields), driverController.uploadKYCDocuments);
// Notice: removed /kyc-selfie as it's included in kyc-documents above
router.put('/:id/kyc-submit', driverController.submitKYC);

// Admin KYC routes
router.get('/kyc/pending', driverController.getPendingKYC);
router.get('/:id/kyc', driverController.getDriverKYC);
router.put('/:id/kyc/approve', driverController.approveKYC);
router.put('/:id/kyc/reject', driverController.rejectKYC);
router.put('/:id/kyc/request-reupload', driverController.requestKYCReUpload);
router.put('/:id/kyc/reset', driverController.resetToPending);
router.put('/:id/add-vehicle', driverController.addVehicle);

// Admin Driver Management routes
router.put('/:id/block', driverController.blockDriver);
router.put('/:id/unblock', driverController.unblockDriver);

module.exports = router;
