const mongoose = require('mongoose');

// MongoDB connection options
const options = {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    family: 4 // Use IPv4, skip trying IPv6
};

class Database {
    constructor() {
        this.isConnected = false;
    }

    async connect() {
        try {
            if (this.isConnected) {
                console.log('✅ MongoDB already connected');
                return;
            }

            const mongoUri = process.env.MONGO_URI
            
            console.log('🔄 Connecting to MongoDB...');
            await mongoose.connect(mongoUri, options);
            
            this.isConnected = true;
            console.log('✅ MongoDB connected successfully');
            
            // Handle connection events
            mongoose.connection.on('error', err => {
                console.error('❌ MongoDB connection error:', err);
                this.isConnected = false;
            });
            
            mongoose.connection.on('disconnected', () => {
                console.log('⚠️  MongoDB disconnected');
                this.isConnected = false;
            });
            
            mongoose.connection.on('reconnected', () => {
                console.log('✅ MongoDB reconnected');
                this.isConnected = true;
            });
            
        } catch (error) {
            console.error('❌ MongoDB connection failed:', error.message);
            this.isConnected = false;
            throw error;
        }
    }

    async disconnect() {
        try {
            await mongoose.connection.close();
            this.isConnected = false;
            console.log('✅ MongoDB disconnected');
        } catch (error) {
            console.error('❌ Error disconnecting from MongoDB:', error);
        }
    }

    isReady() {
        return mongoose.connection.readyState === 1;
    }
}

module.exports = new Database();

