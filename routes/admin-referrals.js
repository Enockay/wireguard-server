const Referral = require("../models/Referral");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");

function registerAdminReferralRoutes(app, getDbInitialized) {
    // List all referrals, across all users
    app.get("/api/admin/referrals", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const { page = 1, limit = 50, status } = req.query;

            const query = {};
            if (status) query.status = status;

            const skip = (parseInt(page) - 1) * parseInt(limit);

            const [referrals, total, statusCounts] = await Promise.all([
                Referral.find(query)
                    .populate('referrerId', 'name email')
                    .populate('referredId', 'name email')
                    .sort({ createdAt: -1 })
                    .skip(skip)
                    .limit(parseInt(limit)),
                Referral.countDocuments(query),
                Referral.aggregate([
                    { $group: { _id: '$status', count: { $sum: 1 } } }
                ])
            ]);

            const statusMap = { pending: 0, completed: 0, rewarded: 0 };
            statusCounts.forEach(s => { statusMap[s._id] = s.count; });

            res.json({
                success: true,
                referrals: referrals.map(r => ({
                    id: r._id,
                    referralCode: r.referralCode,
                    status: r.status,
                    rewardGiven: r.rewardGiven,
                    rewardAmount: r.rewardAmount,
                    referrer: r.referrerId ? { id: r.referrerId._id, name: r.referrerId.name, email: r.referrerId.email } : null,
                    referred: r.referredId ? { id: r.referredId._id, name: r.referredId.name, email: r.referredId.email } : null,
                    completedAt: r.completedAt,
                    createdAt: r.createdAt
                })),
                summary: statusMap,
                pagination: {
                    page: parseInt(page),
                    limit: parseInt(limit),
                    total,
                    pages: Math.ceil(total / parseInt(limit))
                }
            });
        } catch (error) {
            log('error', 'admin_list_referrals_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to list referrals", details: error.message });
        }
    });
}

module.exports = registerAdminReferralRoutes;
