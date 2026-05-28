const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGO_URI);
const Driver = require('./models/Driver');

(async () => {
  const drivers = await Driver.find({}).lean();
  console.log(JSON.stringify(drivers, null, 2));
  process.exit(0);
})();
