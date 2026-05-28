const Notification = require('../models/Notification');

// GET /api/notifications
// Fetch all notifications sorted by newest
const getNotifications = async (req, res) => {
    try {
        const notifications = await Notification.find().sort({ createdAt: -1 }).limit(50);
        return res.status(200).json(notifications);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// PUT /api/notifications/:id/read
// Mark a notification as read
const markAsRead = async (req, res) => {
    const { id } = req.params;
    try {
        const notification = await Notification.findByIdAndUpdate(
            id,
            { isRead: true },
            { new: true }
        );
        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        return res.status(200).json(notification);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// GET /api/notifications/driver/:id
// Fetch notifications specific to a driver
const getDriverNotifications = async (req, res) => {
    const { id } = req.params;
    try {
        const notifications = await Notification.find({ relatedId: id, onModel: 'Driver' })
            .sort({ createdAt: -1 })
            .limit(50);
        return res.status(200).json(notifications);
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// PUT /api/notifications/driver/:id/read-all
// Mark all notifications for a specific driver as read
const markDriverNotificationsAsRead = async (req, res) => {
    const { id } = req.params;
    try {
        await Notification.updateMany(
            { relatedId: id, onModel: 'Driver', isRead: false },
            { isRead: true }
        );
        return res.status(200).json({ message: 'Driver notifications marked as read' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// DELETE /api/notifications/:id
// Delete a single notification
const deleteNotification = async (req, res) => {
    const { id } = req.params;
    try {
        const notification = await Notification.findById(id);
        if (!notification) {
            return res.status(404).json({ error: 'Notification not found' });
        }
        await Notification.findByIdAndDelete(id);
        return res.status(200).json({ message: 'Notification deleted successfully' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// DELETE /api/notifications/driver/:id/all
// Delete all notifications for a specific driver
const deleteDriverNotifications = async (req, res) => {
    const { id } = req.params;
    try {
        await Notification.deleteMany({ relatedId: id, onModel: 'Driver' });
        return res.status(200).json({ message: 'All driver notifications deleted successfully' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

// Mark all notifications across the system as read
const markAllAsRead = async (req, res) => {
    try {
        await Notification.updateMany({ isRead: false }, { isRead: true });
        return res.status(200).json({ message: 'All notifications marked as read' });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getNotifications,
    markAsRead,
    markAllAsRead,
    getDriverNotifications,
    markDriverNotificationsAsRead,
    deleteNotification,
    deleteDriverNotifications
};
