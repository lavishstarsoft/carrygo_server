/** Notify admin dashboard to refresh fleet ops (offers, trips, locations). */
const emitAdminFleetPulse = (io, reason = 'update') => {
    if (!io) return;
    io.to('admin_room').emit('admin_fleet_pulse', {
        reason,
        at: new Date().toISOString(),
    });
};

module.exports = { emitAdminFleetPulse };
