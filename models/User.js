const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true,
        index: true,
        validate: {
            validator: function(v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: 'Invalid email format'
        }
    },
    password: {
        type: String,
        required: true,
        minlength: 6
    },
    name: {
        type: String,
        required: true,
        trim: true
    },
    emailVerified: {
        type: Boolean,
        default: false
    },
    emailVerifiedAt: {
        type: Date
    },
    emailVerificationToken: {
        type: String,
        index: true
    },
    emailVerificationExpires: {
        type: Date
    },
    lastVerificationEmailSentAt: {
        type: Date
    },
    passwordResetToken: {
        type: String,
        index: true
    },
    passwordResetExpires: {
        type: Date
    },
    passwordResetRequestedAt: {
        type: Date
    },
    passwordResetCompletedAt: {
        type: Date
    },
    isActive: {
        type: Boolean,
        default: true
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user'
    },
    trialEndsAt: {
        type: Date,
        default: function() {
            // 1 week free trial
            const date = new Date();
            date.setDate(date.getDate() + 7);
            return date;
        }
    },
    trialUsed: {
        type: Boolean,
        default: false
    },
    referralCode: {
        type: String,
        unique: true,
        sparse: true,
        index: true
    },
    balance: {
        type: Number,
        default: 0,
        min: 0
    },
    currency: {
        type: String,
        default: 'USD'
    },
    company: {
        type: String,
        trim: true
    },
    phone: {
        type: String,
        trim: true
    },
    country: {
        type: String,
        trim: true
    },
    timezone: {
        type: String,
        trim: true
    },
    supportTier: {
        type: String,
        enum: ['standard', 'priority', 'vip'],
        default: 'standard'
    },
    supportRole: {
        type: String,
        enum: ['none', 'agent', 'manager'],
        default: 'none'
    },
    supportTeam: {
        type: String,
        enum: ['general', 'networking', 'billing', 'security', 'vip', 'operations'],
        default: 'general'
    },
    riskStatus: {
        type: String,
        enum: ['normal', 'watchlist', 'flagged', 'restricted'],
        default: 'normal'
    },
    internalFlags: [{
        flag: {
            type: String,
            trim: true
        },
        severity: {
            type: String,
            enum: ['low', 'medium', 'high'],
            default: 'medium'
        },
        description: {
            type: String,
            trim: true
        },
        createdBy: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    adminNotes: [{
        body: {
            type: String,
            required: true,
            trim: true
        },
        category: {
            type: String,
            enum: ['billing', 'payment', 'subscription', 'overdue', 'support', 'finance_review', 'grace_period', 'adjustment', 'security', 'abuse', 'networking', 'onboarding', 'vip', 'technical', 'follow_up'],
            default: 'support'
        },
        pinned: {
            type: Boolean,
            default: false
        },
        author: {
            type: String,
            trim: true,
            default: 'system'
        },
        createdAt: {
            type: Date,
            default: Date.now
        }
    }],
    lastLoginAt: {
        type: Date
    },
    lastFailedLoginAt: {
        type: Date
    },
    failedLoginCount: {
        type: Number,
        default: 0,
        min: 0
    },
    sessionsRevokedAt: {
        type: Date
    },
    lastSecurityReviewAt: {
        type: Date
    }
}, {
    timestamps: true,
    collection: 'users'
});

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    this.password = await bcrypt.hash(this.password, 10);
    next();
});

// Generate email verification token
userSchema.methods.generateVerificationToken = function() {
    const token = crypto.randomBytes(32).toString('hex');
    this.emailVerificationToken = token;
    this.emailVerificationExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    return token;
};

// Generate password reset token
userSchema.methods.generatePasswordResetToken = function() {
    const token = crypto.randomBytes(32).toString('hex');
    this.passwordResetToken = token;
    this.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    return token;
};

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
    return bcrypt.compare(candidatePassword, this.password);
};

// Check if user is in trial period
userSchema.methods.isInTrial = function() {
    return !this.trialUsed && this.trialEndsAt && new Date() < this.trialEndsAt;
};

// Remove password from JSON
userSchema.methods.toJSON = function() {
    const obj = this.toObject();
    delete obj.password;
    delete obj.emailVerificationToken;
    return obj;
};

// Indexes
userSchema.index({ createdAt: -1 });

module.exports = mongoose.model('User', userSchema);
