const User = require('../models/User');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../services/email-service');
const { recordAdminAction } = require('../services/admin-audit-service');
const { requireAdminPermission } = require('../middleware/admin-auth');
const { revokeAllUserSessions, recordSecurityEvent } = require('../services/security-event-service');
const {
  ADMIN_PERMISSIONS,
  NOTE_CATEGORIES,
  FLAG_TYPES,
  FLAG_SEVERITIES,
  buildRiskStatus,
  getAdminUserStats,
  listAdminUsers,
  getAdminUserDetail,
  getAdminUserServices,
  getAdminUserRouters,
  getAdminUserBilling,
  getAdminUserActivity,
  getAdminUserSecurity,
  getAdminUserSupport,
  getAdminUserNotes,
  getAdminUserFlags
} = require('../services/admin-user-service');

async function getTargetUserOr404(req, res) {
  const user = await User.findById(req.params.id);
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return null;
  }
  return user;
}

function normalizeReason(value) {
  return value ? String(value).trim() : '';
}

function validateDays(value) {
  const days = Number(value || 7);
  if (!Number.isFinite(days) || days < 1) {
    return null;
  }
  return Math.floor(days);
}

async function audit(req, targetUserId, action, reason, metadata = {}) {
  return recordAdminAction({
    req,
    actorUserId: req.adminUser._id,
    targetUserId,
    action,
    reason,
    metadata
  });
}

function registerAdminUserRoutes(app) {
  app.get('/api/admin/users/stats', requireAdminPermission(ADMIN_PERMISSIONS.VIEW), async (req, res) => {
    try {
      const stats = await getAdminUserStats();
      res.json({ success: true, stats });
    } catch (error) {
      res.status(500).json({ success: false, error: 'Failed to load user stats', details: error.message });
    }
  });

  app.get('/api/admin/users', requireAdminPermission(ADMIN_PERMISSIONS.VIEW), async (req, res) => {
    try {
      const result = await listAdminUsers(req.query || {});
      if (result.format === 'csv') {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="admin-users-export.csv"');
        return res.send(result.csv);
      }

      return res.json({ success: true, items: result.items, pagination: result.pagination });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load users', details: error.message });
    }
  });

  app.get('/api/admin/users/:id', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
    try {
      const payload = await getAdminUserDetail(req.params.id);
      if (!payload) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, data: payload });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user details', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/services', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
    try {
      const data = await getAdminUserServices(req.params.id);
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, services: data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user services', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/routers', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
    try {
      const data = await getAdminUserRouters(req.params.id);
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, ...data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user routers', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/billing', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_BILLING), async (req, res) => {
    try {
      const data = await getAdminUserBilling(req.params.id);
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, billing: data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user billing', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/activity', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
    try {
      const data = await getAdminUserActivity(req.params.id, req.query || {});
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, items: data.items, pagination: data.pagination });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user activity', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/security', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_SECURITY), async (req, res) => {
    try {
      const data = await getAdminUserSecurity(req.params.id);
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, security: data });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user security', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/support', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_SUPPORT), async (req, res) => {
    try {
      const data = await getAdminUserSupport(req.params.id, req.query || {});
      if (!data) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, summary: data.summary, items: data.items, pagination: data.pagination });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user support history', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/notes', requireAdminPermission(ADMIN_PERMISSIONS.VIEW_DETAILS), async (req, res) => {
    try {
      const notes = await getAdminUserNotes(req.params.id);
      if (!notes) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, items: notes });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load user notes', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/notes', requireAdminPermission(ADMIN_PERMISSIONS.ADD_NOTE), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      if (!req.body?.body || !String(req.body.body).trim()) {
        return res.status(400).json({ success: false, error: 'Note body is required' });
      }
      if (req.body.category && !NOTE_CATEGORIES.includes(req.body.category)) {
        return res.status(400).json({ success: false, error: 'Invalid note category', categories: NOTE_CATEGORIES });
      }

      user.adminNotes.push({
        body: String(req.body.body).trim(),
        category: req.body.category || 'support',
        pinned: Boolean(req.body.pinned),
        author: req.adminUser.email
      });
      await user.save();
      await audit(req, user._id, 'admin.users.add_note', normalizeReason(req.body.reason), {
        category: req.body.category || 'support',
        pinned: Boolean(req.body.pinned)
      });

      return res.json({ success: true, message: 'Note added successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to add note', details: error.message });
    }
  });

  app.get('/api/admin/users/:id/flags', requireAdminPermission(ADMIN_PERMISSIONS.FLAG), async (req, res) => {
    try {
      const flags = await getAdminUserFlags(req.params.id);
      if (!flags) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      return res.json({ success: true, riskStatus: flags.riskStatus, items: flags.items });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to load flags', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/flags', requireAdminPermission(ADMIN_PERMISSIONS.FLAG), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      if (!req.body?.flag) {
        return res.status(400).json({ success: false, error: 'Flag name is required' });
      }
      if (!FLAG_TYPES.includes(req.body.flag)) {
        return res.status(400).json({ success: false, error: 'Invalid flag type', flagTypes: FLAG_TYPES });
      }
      if (req.body.severity && !FLAG_SEVERITIES.includes(req.body.severity)) {
        return res.status(400).json({ success: false, error: 'Invalid flag severity', severities: FLAG_SEVERITIES });
      }

      user.internalFlags.push({
        flag: req.body.flag,
        severity: req.body.severity || 'medium',
        description: req.body.description || '',
        createdBy: req.adminUser.email
      });
      if (req.body.severity === 'high') {
        user.riskStatus = 'flagged';
      }
      await user.save();
      await audit(req, user._id, 'admin.users.add_flag', normalizeReason(req.body.reason), {
        flag: req.body.flag,
        severity: req.body.severity || 'medium',
        description: req.body.description || ''
      });

      return res.json({ success: true, message: 'Flag added successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to add flag', details: error.message });
    }
  });

  app.delete('/api/admin/users/:id/flags/:flagId', requireAdminPermission(ADMIN_PERMISSIONS.FLAG), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const flag = user.internalFlags.id(req.params.flagId);
      if (!flag) {
        return res.status(404).json({ success: false, error: 'Flag not found' });
      }

      const removedFlag = { flag: flag.flag, severity: flag.severity, description: flag.description };
      flag.deleteOne();
      if (!user.internalFlags.length) {
        user.riskStatus = 'normal';
      } else if (!user.internalFlags.some((item) => item.severity === 'high') && user.riskStatus === 'flagged') {
        user.riskStatus = 'normal';
      }
      await user.save();
      await audit(req, user._id, 'admin.users.remove_flag', normalizeReason(req.body?.reason), removedFlag);

      return res.json({ success: true, message: 'Flag removed successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to remove flag', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/suspend', requireAdminPermission(ADMIN_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const reason = normalizeReason(req.body?.reason);

      user.isActive = false;
      user.sessionsRevokedAt = new Date();
      if (reason) {
        user.adminNotes.push({ body: `Suspended account: ${reason}`, category: 'support', author: req.adminUser.email, pinned: true });
      }
      await user.save();
      await audit(req, user._id, 'admin.users.suspend', reason, { accountStatus: 'suspended' });

      return res.json({ success: true, message: 'User suspended successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to suspend user', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/reactivate', requireAdminPermission(ADMIN_PERMISSIONS.MANAGE_STATUS), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const reason = normalizeReason(req.body?.reason);

      user.isActive = true;
      if (reason) {
        user.adminNotes.push({ body: `Reactivated account: ${reason}`, category: 'support', author: req.adminUser.email });
      }
      await user.save();
      await audit(req, user._id, 'admin.users.reactivate', reason, { accountStatus: 'active' });

      return res.json({ success: true, message: 'User reactivated successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to reactivate user', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/verify', requireAdminPermission(ADMIN_PERMISSIONS.VERIFY), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const reason = normalizeReason(req.body?.reason);

      user.emailVerified = true;
      user.emailVerifiedAt = new Date();
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      user.adminNotes.push({ body: reason ? `Admin manually marked user as verified. ${reason}` : 'Admin manually marked user as verified.', category: 'onboarding', author: req.adminUser.email });
      await user.save();
      await audit(req, user._id, 'admin.users.verify', reason, { verificationStatus: 'verified' });

      return res.json({ success: true, message: 'User verified successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to verify user', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/resend-verification', requireAdminPermission(ADMIN_PERMISSIONS.VERIFY), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      if (user.emailVerified) {
        return res.status(400).json({ success: false, error: 'Email already verified' });
      }

      const reason = normalizeReason(req.body?.reason);
      const verificationToken = user.generateVerificationToken();
      await sendVerificationEmail(user, verificationToken);
      user.lastVerificationEmailSentAt = new Date();
      await user.save();
      await audit(req, user._id, 'admin.users.resend_verification', reason, {});

      return res.json({ success: true, message: 'Verification email sent successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to resend verification email', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/send-password-reset', requireAdminPermission(ADMIN_PERMISSIONS.FORCE_PASSWORD_RESET), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const reason = normalizeReason(req.body?.reason);

      const resetToken = user.generatePasswordResetToken();
      user.passwordResetRequestedAt = new Date();
      await user.save();
      await sendPasswordResetEmail(user, resetToken);
      await recordSecurityEvent({
        eventType: 'password_reset_requested',
        category: 'account',
        severity: 'high',
        source: 'admin',
        success: true,
        userId: user._id,
        actorUserId: req.adminUser._id,
        reason,
        metadata: { initiatedByAdmin: true }
      });
      await audit(req, user._id, 'admin.users.send_password_reset', reason, {});

      return res.json({ success: true, message: 'Password reset email sent successfully' });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to send password reset email', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/force-logout', requireAdminPermission(ADMIN_PERMISSIONS.FORCE_LOGOUT), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const reason = normalizeReason(req.body?.reason);

      user.sessionsRevokedAt = new Date();
      user.lastSecurityReviewAt = new Date();
      await user.save();
      await revokeAllUserSessions(user._id, req.adminUser.email, reason, req.adminUser._id);
      await audit(req, user._id, 'admin.users.force_logout', reason, { sessionsRevokedAt: user.sessionsRevokedAt });

      return res.json({ success: true, message: 'User sessions revoked successfully', sessionsRevokedAt: user.sessionsRevokedAt });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to revoke user sessions', details: error.message });
    }
  });

  app.post('/api/admin/users/:id/extend-trial', requireAdminPermission(ADMIN_PERMISSIONS.EXTEND_TRIAL), async (req, res) => {
    try {
      const user = await getTargetUserOr404(req, res);
      if (!user) return;
      const days = validateDays(req.body?.days);
      if (!days) {
        return res.status(400).json({ success: false, error: 'days must be a positive integer' });
      }
      const reason = normalizeReason(req.body?.reason);

      const base = user.trialEndsAt && new Date(user.trialEndsAt) > new Date() ? new Date(user.trialEndsAt) : new Date();
      base.setDate(base.getDate() + days);
      user.trialEndsAt = base;
      user.adminNotes.push({ body: `Extended trial by ${days} day(s). ${reason}`.trim(), category: 'billing', author: req.adminUser.email });
      await user.save();
      await audit(req, user._id, 'admin.users.extend_trial', reason, { days, trialEndsAt: user.trialEndsAt });

      return res.json({ success: true, message: 'Trial extended successfully', trialEndsAt: user.trialEndsAt });
    } catch (error) {
      return res.status(500).json({ success: false, error: 'Failed to extend trial', details: error.message });
    }
  });
}

module.exports = registerAdminUserRoutes;
