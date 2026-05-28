const Setting = require('../models/Setting');

// Get a setting by key
const getSetting = async (req, res) => {
    try {
        const { key } = req.params;
        const setting = await Setting.findOne({ key });

        if (!setting) {
            // Return default for 'app_settings' if not found
            if (key === 'app_settings') {
                return res.status(200).json({
                    key: 'app_settings',
                    value: {
                        cities: [
                            'Vijayawada',
                            'Hyderabad',
                            'Visakhapatnam',
                            'Guntur',
                            'Rajahmundry',
                            'Tirupati',
                            'Kakinada',
                            'Nellore',
                            'Kurnool'
                        ],
                        vehicleTypes: [
                            {
                                id: 'truck', label: 'Truck', icon: '🚚',
                                optionLists: [
                                    { key: 'bodyTypes', label: 'Vehicle Body Type', hasIcon: true, options: [{ id: 'open', label: 'Open Body', icon: '📦' }, { id: 'closed', label: 'Closed Container', icon: '🚐' }] },
                                    { key: 'fuelTypes', label: 'Fuel Type', hasIcon: false, options: [{ id: 'diesel', label: 'Diesel' }, { id: 'petrol', label: 'Petrol' }] }
                                ]
                            },
                            {
                                id: '3w', label: '3W', icon: '🛺',
                                optionLists: [
                                    { key: 'bodyTypes', label: 'Vehicle Body Type', hasIcon: true, options: [{ id: 'auto', label: 'Auto', icon: '🛺' }, { id: 'loader', label: 'Loader', icon: '🚛' }] },
                                    { key: 'fuelTypes', label: 'Fuel Type', hasIcon: false, options: [{ id: 'cng', label: 'CNG' }, { id: 'ev', label: 'EV' }, { id: 'petrol', label: 'Petrol' }] }
                                ]
                            },
                            {
                                id: '2w', label: '2W', icon: '🛵',
                                optionLists: [
                                    { key: 'bodyTypes', label: 'Vehicle Body Type', hasIcon: true, options: [{ id: 'scooter', label: 'Scooter', icon: '🛵' }, { id: 'bike', label: 'Bike', icon: '🏍️' }] },
                                    { key: 'fuelTypes', label: 'Fuel Type', hasIcon: false, options: [{ id: 'petrol', label: 'Petrol' }, { id: 'ev', label: 'EV' }] }
                                ]
                            }
                        ]
                    }
                });
            }
            return res.status(404).json({ error: 'Setting not found' });
        }

        res.status(200).json(setting);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// Update or create a setting
const updateSetting = async (req, res) => {
    try {
        const { key } = req.params;
        const { value } = req.body;

        const updatedSetting = await Setting.findOneAndUpdate(
            { key },
            { value },
            { new: true, upsert: true }
        );

        res.status(200).json(updatedSetting);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

module.exports = {
    getSetting,
    updateSetting,
};
