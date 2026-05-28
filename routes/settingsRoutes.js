const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// Get a setting by key 
// E.g. GET /api/settings/app_settings
router.get('/:key', settingsController.getSetting);

// Create or update a setting
// E.g. PUT /api/settings/app_settings { ...data }
router.put('/:key', settingsController.updateSetting);

module.exports = router;
