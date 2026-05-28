const express = require('express');
const router = express.Router();
const fareController = require('../controllers/fareController');

// Public — fare estimate (user app uses this)
router.post('/estimate', fareController.estimateFare);
router.get('/geocode', fareController.geocode);
router.get('/autocomplete', fareController.autocomplete);

// Admin — pricing & zone management
router.get('/pricing', fareController.getAllPricing);
router.post('/pricing', fareController.upsertPricing);
router.delete('/pricing/:id', fareController.deletePricing);
router.put('/surge', fareController.toggleSurge);

// Zones
router.get('/zones', fareController.getZones);
router.post('/zones', fareController.upsertZone);
router.delete('/zones/:id', fareController.deleteZone);

module.exports = router;
