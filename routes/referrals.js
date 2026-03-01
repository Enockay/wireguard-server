const User = require('../models/User');
const Referral = require('../models/Referral');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');
const crypto = require('crypto');

function registerReferralRoutes(app) {
    // Get user's referral code
    app.get('/api/referrals/code', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const user = await User.findById(userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            // Generate referral code if doesn't exist
            if (!user.referralCode) {
                user.referralCode = crypto.randomBytes(8).toString('hex').toUpperCase();
                await user.save();
            }

            res.json({
                success: true,
                referralCode: user.referralCode,
                referralLink: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/signup?ref=${user.referralCode}`
            });
        } catch (error) {
            log('error', 'get_referral_code_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get referral code',
                details: error.message
            });
        }
    });

    // Get referral stats
    app.get('/api/referrals/stats', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;

            const totalReferrals = await Referral.countDocuments({ referrerId: userId });
            const completedReferrals = await Referral.countDocuments({ 
                referrerId: userId, 
                status: 'completed' 
            });
            const pendingReferrals = await Referral.countDocuments({ 
                referrerId: userId, 
                status: 'pending' 
            });
            const totalRewards = await Referral.aggregate([
                { $match: { referrerId: userId, rewardGiven: true } },
                { $group: { _id: null, total: { $sum: '$rewardAmount' } } }
            ]);

            res.json({
                success: true,
                stats: {
                    totalReferrals,
                    completedReferrals,
                    pendingReferrals,
                    totalRewards: totalRewards[0]?.total || 0
                }
            });
        } catch (error) {
            log('error', 'get_referral_stats_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get referral stats',
                details: error.message
            });
        }
    });

    // Get referral list
    app.get('/api/referrals', authenticateToken, async (req, res) => {
        try {
            const userId = req.user.userId;
            const { page = 1, limit = 20 } = req.query;

            const referrals = await Referral.find({ referrerId: userId })
                .populate('referredId', 'name email createdAt')
                .sort({ createdAt: -1 })
                .limit(parseInt(limit))
                .skip((parseInt(page) - 1) * parseInt(limit));

            const total = await Referral.countDocuments({ referrerId: userId });

            res.json({
                success: true,
                referrals: referrals.map(ref => ({
                    id: ref._id,
                    referredUser: {
                        name: ref.referredId?.name,
                        email: ref.referredId?.email,
                        joinedAt: ref.referredId?.createdAt
                    },
                    status: ref.status,
                    rewardGiven: ref.rewardGiven,
                    rewardAmount: ref.rewardAmount,
                    completedAt: ref.completedAt,
                    createdAt: ref.createdAt
                })),
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'get_referrals_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get referrals',
                details: error.message
            });
        }
    });
}

module.exports = registerReferralRoutes;
