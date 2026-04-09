const mongoose = require('mongoose');

const adminNotificationStateSchema = new mongoose.Schema({
    adminUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        unique: true,
        index: true
    },
    readNotificationIds: [{
        type: String,
        trim: true
    }],
    readAllAt: {
        type: Date
    }
}, {
    timestamps: true,
    collection: 'admin_notification_states'
});

module.exports = mongoose.model('AdminNotificationState', adminNotificationStateSchema);
