const express = require('express');
const router = express.Router();
const mapsController = require('../controllers/mapsController');

router.get('/fleet-static', mapsController.getFleetStaticMap);

module.exports = router;
