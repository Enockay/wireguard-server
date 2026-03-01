const User = require('../models/User');
const { log } = require('../wg-core');
const { authenticateToken } = require('./auth');
const bcrypt = require('bcryptjs');

function registerProfileRoutes(app) {
    // Get user profile
    app.get('/api/profile', authenticateToken, async (req, res) => {
        try {
            const user = await User.findById(req.user.userId).select('-password');
            
            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            res.json({
                success: true,
                user: user.toJSON()
            });
        } catch (error) {
            log('error', 'get_profile_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to get profile',
                details: error.message
            });
        }
    });

    // Update user profile
    app.put('/api/profile', authenticateToken, async (req, res) => {
        try {
            const { name, currentPassword, newPassword } = req.body;
            const user = await User.findById(req.user.userId);

            if (!user) {
                return res.status(404).json({
                    success: false,
                    error: 'User not found'
                });
            }

            // Update name if provided
            if (name) {
                user.name = name;
            }

            // Update password if provided
            if (newPassword) {
                if (!currentPassword) {
                    return res.status(400).json({
                        success: false,
                        error: 'Current password is required to change password'
                    });
                }

                const isValidPassword = await user.comparePassword(currentPassword);
                if (!isValidPassword) {
                    return res.status(401).json({
                        success: false,
                        error: 'Current password is incorrect'
                    });
                }

                if (newPassword.length < 6) {
                    return res.status(400).json({
                        success: false,
                        error: 'New password must be at least 6 characters'
                    });
                }

                user.password = newPassword; // Will be hashed by pre-save hook
            }

            await user.save();

            res.json({
                success: true,
                message: 'Profile updated successfully',
                user: user.toJSON()
            });
        } catch (error) {
            log('error', 'update_profile_error', { error: error.message });
            res.status(500).json({
                success: false,
                error: 'Failed to update profile',
                details: error.message
            });
        }
    });
}

module.exports = registerProfileRoutes;
