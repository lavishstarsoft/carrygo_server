const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

// Global routes
router.get('/', notificationController.getNotifications);
router.put('/read-all', notificationController.markAllAsRead);
router.put('/:id/read', notificationController.markAsRead);

// Driver specific routes
router.get('/driver/:id', notificationController.getDriverNotifications);
router.put('/driver/:id/read-all', notificationController.markDriverNotificationsAsRead);

// DELETE routes
router.delete('/:id', notificationController.deleteNotification);
router.delete('/driver/:id/all', notificationController.deleteDriverNotifications);

module.exports = router;
