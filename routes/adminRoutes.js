const express = require('express');
const router = express.Router();
const { loginAdmin, seedAdmin } = require('../controllers/adminController');

router.post('/login', loginAdmin);
router.post('/seed', seedAdmin);

module.exports = router;
