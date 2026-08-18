const User = require("../models/User");
const MikrotikRouter = require("../models/MikrotikRouter");
const Transaction = require("../models/Transaction");
const SupportTicket = require("../models/SupportTicket");
const Subscription = require("../models/Subscription");
const { authenticateToken, requireAdmin } = require("./auth");
const { log } = require("../wg-core");

// Every calendar day from `since` to today, defaulting to 0 - so the chart
// always has a full timeline to draw (axis, gridlines, flat baseline) instead
// of an empty array before any transactions exist.
function fillDailySeries(daily, since) {
    const byDate = new Map(daily.map(d => [d._id, d.total]));
    const days = [];
    const cursor = new Date(since);
    cursor.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    while (cursor <= today) {
        const key = cursor.toISOString().slice(0, 10);
        days.push({ date: key, amount: byDate.get(key) || 0 });
        cursor.setDate(cursor.getDate() + 1);
    }
    return days;
}

// "payment" = cash collected via a gateway (wallet top-ups).
// "invoice" = subscription charges deducted from an existing balance.
// Kept separate rather than summed - adding them would double-count money
// that was deposited as a payment and later spent as an invoice.
async function revenueFor(type, since) {
    const match = { status: 'completed', type };
    if (since) match.createdAt = { $gte: since };

    const [totalAgg, daily] = await Promise.all([
        Transaction.aggregate([
            { $match: match },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        since ? Transaction.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
                    total: { $sum: '$amount' }
                }
            },
            { $sort: { _id: 1 } }
        ]) : Promise.resolve(null)
    ]);

    return {
        total: totalAgg[0]?.total || 0,
        daily: daily ? fillDailySeries(daily, since) : undefined
    };
}

function registerAdminAnalyticsRoutes(app, getDbInitialized) {
    app.get("/api/admin/analytics", authenticateToken, requireAdmin, async (req, res) => {
        try {
            const now = new Date();
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

            const [
                totalUsers,
                activeUsers,
                trialUsers,
                adminUsers,
                routersByStatus,
                paymentsAllTime,
                paymentsThisMonth,
                paymentsLast30,
                invoicedAllTime,
                invoicedThisMonth,
                invoicedLast30,
                ticketsByStatus,
                subscriptionsByPlanType,
                mrrAgg,
                potentialMrrAgg,
                stalePastDueTrials
            ] = await Promise.all([
                User.countDocuments(),
                User.countDocuments({ isActive: true }),
                User.countDocuments({ trialUsed: false, trialEndsAt: { $gt: now } }),
                User.countDocuments({ role: 'admin' }),
                MikrotikRouter.aggregate([
                    { $group: { _id: '$status', count: { $sum: 1 } } }
                ]),
                revenueFor('payment', null),
                revenueFor('payment', startOfMonth),
                revenueFor('payment', thirtyDaysAgo),
                revenueFor('invoice', null),
                revenueFor('invoice', startOfMonth),
                revenueFor('invoice', thirtyDaysAgo),
                SupportTicket.aggregate([
                    { $group: { _id: '$status', count: { $sum: 1 } } }
                ]),
                Subscription.aggregate([
                    { $match: { status: { $in: ['trial', 'active', 'past_due'] } } },
                    { $group: { _id: '$planType', count: { $sum: 1 } } }
                ]),
                // MRR: currently-paying recurring revenue
                Subscription.aggregate([
                    { $match: { status: 'active', planType: 'monthly' } },
                    { $group: { _id: null, total: { $sum: '$pricePerMonth' } } }
                ]),
                // Potential MRR: what MRR would be if every current trial/active/past_due subscription were paying
                Subscription.aggregate([
                    { $match: { status: { $in: ['trial', 'active', 'past_due'] } } },
                    { $group: { _id: null, total: { $sum: '$pricePerMonth' } } }
                ]),
                // Diagnostic: trials whose trialEndsAt has passed but never converted (the bug this session fixed)
                Subscription.countDocuments({
                    planType: 'trial',
                    trialEndsAt: { $lte: now },
                    status: { $nin: ['canceled', 'expired'] }
                })
            ]);

            const routerStatusMap = { active: 0, offline: 0, pending: 0, inactive: 0 };
            routersByStatus.forEach(r => { routerStatusMap[r._id] = r.count; });

            const ticketStatusMap = { open: 0, in_progress: 0, resolved: 0, closed: 0 };
            ticketsByStatus.forEach(t => { ticketStatusMap[t._id] = t.count; });

            const planTypeMap = { trial: 0, monthly: 0 };
            subscriptionsByPlanType.forEach(s => { planTypeMap[s._id] = s.count; });

            res.json({
                success: true,
                analytics: {
                    users: {
                        total: totalUsers,
                        active: activeUsers,
                        inactive: totalUsers - activeUsers,
                        inTrial: trialUsers,
                        admins: adminUsers
                    },
                    routers: {
                        total: Object.values(routerStatusMap).reduce((a, b) => a + b, 0),
                        byStatus: routerStatusMap
                    },
                    revenue: {
                        payments: {
                            allTime: paymentsAllTime.total,
                            thisMonth: paymentsThisMonth.total,
                            last30Days: paymentsLast30.daily
                        },
                        invoiced: {
                            allTime: invoicedAllTime.total,
                            thisMonth: invoicedThisMonth.total,
                            last30Days: invoicedLast30.daily
                        },
                        mrr: mrrAgg[0]?.total || 0,
                        potentialMrr: potentialMrrAgg[0]?.total || 0
                    },
                    subscriptions: {
                        byPlanType: planTypeMap,
                        stalePastDueTrials
                    },
                    support: {
                        total: Object.values(ticketStatusMap).reduce((a, b) => a + b, 0),
                        byStatus: ticketStatusMap
                    }
                }
            });
        } catch (error) {
            log('error', 'admin_analytics_error', { error: error.message });
            res.status(500).json({ success: false, error: "Failed to load analytics", details: error.message });
        }
    });
}

module.exports = registerAdminAnalyticsRoutes;
