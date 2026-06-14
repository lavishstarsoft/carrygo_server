const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const Redis = require('ioredis');
const { redisConfig } = require('./config/redis');
const cors = require('cors');
require('dotenv').config();

const userRoutes = require('./routes/userRoutes');
const driverRoutes = require('./routes/driverRoutes');
const orderRoutes = require('./routes/orderRoutes');
const adminRoutes = require('./routes/adminRoutes');
const driverAuthRoutes = require('./routes/driverAuthRoutes');
const settingsRoutes = require('./routes/settingsRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const userAuthRoutes = require('./routes/userAuthRoutes');
const fareRoutes = require('./routes/fareRoutes');
const paymentRoutes = require('./routes/paymentRoutes');
const connectDB = require('./config/db');
const { startProductionJobs } = require('./services/productionJobs');

// Connect Database
connectDB();

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Adjust later for security
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Redis Adapter for Socket.io scaling
const pubClient = new Redis(redisConfig);
const subClient = pubClient.duplicate();

pubClient.on('error', (err) => {
  console.error('❌ Redis Pub Client error:', err.message);
});

subClient.on('error', (err) => {
  console.error('❌ Redis Sub Client error:', err.message);
});

io.adapter(createAdapter(pubClient, subClient));

// Make io accessible globally if needed, or pass it to routes
app.set('io', io);

const PORT = process.env.PORT || 4000;

// Middleware
app.use(cors());

// Razorpay webhook needs raw body for signature verification
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  req.rawBody = req.body.toString('utf8');
  try {
    req.body = JSON.parse(req.rawBody);
  } catch {
    req.body = {};
  }
  next();
});

app.use(express.json());

// Socket Connections
io.on('connection', (socket) => {
  console.log(`Socket Client Connected: ${socket.id}`);

  // Driver joins their personal room for targeted notifications
  socket.on('join_driver', (driverId) => {
    socket.join(`driver_${driverId}`);
    console.log(`Driver ${driverId} joined room`);
  });

  // User joins their personal room
  socket.on('join_user', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined room`);
  });

  // Admin dashboard joins for live fleet ops
  socket.on('join_admin', () => {
    socket.join('admin_room');
    console.log(`Admin joined fleet room (${socket.id})`);
  });

  // Driver location update (real-time)
  socket.on('driver_location_update', (data) => {
    const { driver_id, latitude, longitude, order_id, heading } = data;
    // Broadcast to anyone tracking this order
    if (order_id) {
      io.emit(`driver_location_${order_id}`, { latitude, longitude, heading });
    }

    // Broadcast to a general channel for "nearby drivers" map display (Rapido style)
    io.emit('nearby_driver_update', { 
      driver_id, 
      latitude, 
      longitude, 
      vehicle_type: data.vehicle_type 
    });

    io.to('admin_room').emit('admin_driver_location', {
      driver_id: String(driver_id || ''),
      latitude,
      longitude,
      vehicle_type: data.vehicle_type,
      at: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    console.log(`Socket Client Disconnected: ${socket.id}`);
  });
});

// Routes
app.use('/api/users', userRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/driver-auth', driverAuthRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/user-auth', userAuthRoutes);
app.use('/api/fare', fareRoutes);
app.use('/api/payments', paymentRoutes);

// Serve uploaded files
app.use('/uploads', express.static('uploads'));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date() });
});

const HOST = '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`Server & Socket.io are running on http://${HOST}:${PORT}`);
  startProductionJobs(io);
});
