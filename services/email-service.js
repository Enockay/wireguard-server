const https = require('https');
const { log } = require('../wg-core');

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BASE_URL = process.env.SERVICE_URL_WIREGUARD || process.env.SERVICE_FQDN_WIREGUARD || 'https://vpn.blackie-networks.com';
const FRONTEND_URL = process.env.FRONTEND_URL || process.env.SERVICE_URL_WIREGUARD || process.env.SERVICE_FQDN_WIREGUARD || 'https://vpn.blackie-networks.com';

// Admin-editable via Settings (config-cache.js); env vars are just the seed/fallback.
function getSenderEmail() {
    const { getConfig } = require('../config-cache');
    return getConfig('emailSenderEmail') || process.env.BREVO_SENDER_EMAIL || 'noreply@blackie-networks.com';
}
function getSenderName() {
    const { getConfig } = require('../config-cache');
    return getConfig('emailSenderName') || process.env.BREVO_SENDER_NAME || 'Blackie Networks';
}
function getReplyToEmail() {
    const { getConfig } = require('../config-cache');
    return getConfig('emailReplyToEmail') || process.env.BREVO_REPLY_TO_EMAIL || 'support@blackie-networks.com';
}
// Admin-editable via Settings (serverEndpoint), same source routes/mikrotik-routers.js's
// getPublicHost() uses - router access ports must reflect *this* deployment's own
// domain, not a hardcoded one, otherwise a test/staging deployment's emails point
// customers at production's hostname (and vice versa).
function getPublicHost() {
    const { getServerEndpoint } = require('../wg-core');
    return getServerEndpoint().split(':')[0];
}

// Shared visual language for the router lifecycle emails below - a single
// source of truth so both stay in sync rather than drifting apart.
const EMAIL_STYLES = `
    body { margin: 0; padding: 0; background-color: #eef1f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1f2937; }
    .container { max-width: 560px; margin: 32px auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08); }
    .header { padding: 32px 32px 28px; text-align: center; color: #ffffff; }
    .header h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: -0.01em; }
    .content { padding: 32px; }
    .content h2 { margin: 0 0 16px; font-size: 18px; font-weight: 700; color: #111827; }
    .content p { margin: 0 0 14px; font-size: 14px; line-height: 1.65; color: #4b5563; }
    .card { background-color: #f9fafb; border: 1px solid #eef0f3; border-radius: 12px; padding: 18px 20px; margin: 18px 0; }
    .card h3 { margin: 0 0 12px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #6b7280; }
    .row { display: table; width: 100%; margin-bottom: 8px; font-size: 14px; }
    .row:last-child { margin-bottom: 0; }
    .row-label { display: table-cell; color: #6b7280; width: 40%; }
    .row-value { display: table-cell; color: #111827; font-weight: 600; }
    .badge { display: inline-block; font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; background-color: #eef2ff; color: #4338ca; padding: 3px 9px; border-radius: 6px; text-decoration: none; }
    .steps { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.8; color: #4b5563; }
    .footer { text-align: center; padding: 22px 32px 30px; color: #9ca3af; font-size: 12px; }
`;

/**
 * Send email using Brevo API
 */
function sendEmail({ to, subject, htmlContent, textContent }) {
    return new Promise((resolve, reject) => {
        if (!BREVO_API_KEY) {
            log('error', 'brevo_api_key_missing');
            return reject(new Error('Brevo API key not configured'));
        }

        // Validate required fields first
        if (!to || !subject) {
            return reject(new Error('Email recipient and subject are required'));
        }

        // Ensure both htmlContent and textContent are valid strings
        let finalHtmlContent = htmlContent ? String(htmlContent).trim() : '';
        let finalTextContent = textContent ? String(textContent).trim() : '';

        // If only one is provided, generate the other
        if (finalHtmlContent && !finalTextContent) {
            // Generate text from HTML
            finalTextContent = finalHtmlContent
                .replace(/<[^>]*>/g, '')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&quot;/g, '"')
                .replace(/\s+/g, ' ')
                .trim();
        } else if (finalTextContent && !finalHtmlContent) {
            // Generate HTML from text
            finalHtmlContent = `<p>${finalTextContent.replace(/\n/g, '<br>')}</p>`;
        }

        // Final validation
        if (!finalHtmlContent && !finalTextContent) {
            return reject(new Error('Either htmlContent or textContent must be provided'));
        }

        // Ensure we have non-empty strings
        if (!finalHtmlContent || finalHtmlContent.length === 0) {
            return reject(new Error('htmlContent cannot be empty'));
        }
        if (!finalTextContent || finalTextContent.length === 0) {
            return reject(new Error('textContent cannot be empty'));
        }

        const emailData = {
            sender: {
                name: String(getSenderName()),
                email: String(getSenderEmail())
            },
            to: [{ email: String(to).trim() }],
            replyTo: {
                email: String(getReplyToEmail())
            },
            subject: String(subject).trim(),
            htmlContent: finalHtmlContent,
            textContent: finalTextContent
        };

        const data = JSON.stringify(emailData);

        // Log the request for debugging (remove sensitive data in production)
        log('info', 'sending_email', { 
            to, 
            subject, 
            hasHtml: !!finalHtmlContent, 
            hasText: !!finalTextContent 
        });

        const options = {
            hostname: 'api.brevo.com',
            path: '/v3/smtp/email',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'api-key': BREVO_API_KEY
            }
        };

        const req = https.request(options, (res) => {
            let responseData = '';

            res.on('data', (chunk) => {
                responseData += chunk;
            });

            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    log('info', 'email_sent', { to, subject });
                    resolve(JSON.parse(responseData || '{}'));
                } else {
                    log('error', 'email_send_failed', { 
                        to, 
                        subject, 
                        statusCode: res.statusCode,
                        response: responseData 
                    });
                    reject(new Error(`Email send failed: ${res.statusCode} - ${responseData}`));
                }
            });
        });

        req.on('error', (error) => {
            log('error', 'email_request_error', { to, subject, error: error.message });
            reject(error);
        });

        req.write(data);
        req.end();
    });
}

/**
 * Send email verification email
 */
async function sendVerificationEmail(user, token) {
    const verificationUrl = `${BASE_URL}/api/auth/verify-email?token=${token}`;
    
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #4CAF50; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background-color: #f9f9f9; }
                .button { display: inline-block; padding: 12px 24px; background-color: #4CAF50; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Welcome to Blackie Networks!</h1>
                </div>
                <div class="content">
                    <h2>Verify Your Email Address</h2>
                    <p>Hello ${user.name},</p>
                    <p>Thank you for signing up! Please verify your email address by clicking the button below:</p>
                    <a href="${verificationUrl}" class="button">Verify Email</a>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all;">${verificationUrl}</p>
                    <p>This link will expire in 24 hours.</p>
                    <p>If you didn't create an account, please ignore this email.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Welcome to Blackie Networks!

Hello ${user.name},

Thank you for signing up! Please verify your email address by visiting:
${verificationUrl}

This link will expire in 24 hours.

If you didn't create an account, please ignore this email.

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: 'Verify Your Email - Blackie Networks',
        htmlContent,
        textContent
    });
}

/**
 * Send router created notification email
 */
async function sendRouterCreatedEmail(user, router) {
    const host = getPublicHost();
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
        </head>
        <body>
            <div class="container">
                <div class="header" style="background: linear-gradient(135deg, #4f46e5, #4338ca);">
                    <h1>Router Created</h1>
                </div>
                <div class="content">
                    <h2>Your Router is Ready</h2>
                    <p>Hello ${user.name},</p>
                    <p>Your MikroTik router <strong>${router.name}</strong> has been created successfully.</p>

                    <div class="card">
                        <h3>Router Details</h3>
                        <div class="row"><span class="row-label">Name</span><span class="row-value">${router.name}</span></div>
                        <div class="row"><span class="row-label">Status</span><span class="row-value">${router.status}</span></div>
                    </div>

                    <div class="card">
                        <h3>Access Ports</h3>
                        <div class="row"><span class="row-label">Winbox</span><span class="row-value"><span class="badge">${host}:${router.ports.winbox}</span></span></div>
                        <div class="row"><span class="row-label">SSH</span><span class="row-value"><span class="badge">${host}:${router.ports.ssh}</span></span></div>
                        <div class="row"><span class="row-label">API</span><span class="row-value"><span class="badge">${host}:${router.ports.api}</span></span></div>
                    </div>

                    <p style="margin-bottom: 8px;"><strong>Next steps</strong></p>
                    <ol class="steps">
                        <li>Connect your MikroTik router to the VPN using the WireGuard configuration</li>
                        <li>Once connected, you can access it using the ports above</li>
                        <li>You'll receive another email as soon as the router comes online</li>
                    </ol>

                    <p style="margin-top: 18px;">Questions? Just reply to this email.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Router Created

Hello ${user.name},

Your MikroTik router "${router.name}" has been created successfully.

Router Details:
- Name: ${router.name}
- Status: ${router.status}

Access Ports:
- Winbox: ${host}:${router.ports.winbox}
- SSH: ${host}:${router.ports.ssh}
- API: ${host}:${router.ports.api}

Next Steps:
1. Connect your MikroTik router to the VPN using the WireGuard configuration
2. Once connected, you can access it using the ports above
3. You will receive another email when the router comes online

If you have any questions, just reply to this email.

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: `MikroTik Router Created: ${router.name} - Blackie Networks`,
        htmlContent,
        textContent
    });
}

/**
 * Send router online notification email
 */
async function sendRouterOnlineEmail(user, router) {
    const host = getPublicHost();
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>${EMAIL_STYLES}</style>
        </head>
        <body>
            <div class="container">
                <div class="header" style="background: linear-gradient(135deg, #22c55e, #16a34a);">
                    <h1>&#127881; Router is Online</h1>
                </div>
                <div class="content">
                    <h2>Your Router is Now Connected</h2>
                    <p>Hello ${user.name},</p>
                    <p>Great news! Your MikroTik router <strong>${router.name}</strong> is now online and connected to the VPN.</p>

                    <div class="card">
                        <h3>Router Details</h3>
                        <div class="row"><span class="row-label">Name</span><span class="row-value">${router.name}</span></div>
                        <div class="row"><span class="row-label">Status</span><span class="row-value">${router.status}</span></div>
                        <div class="row"><span class="row-label">Connected at</span><span class="row-value">${new Date(router.lastSeen).toLocaleString()}</span></div>
                    </div>

                    <div class="card">
                        <h3>Access Your Router</h3>
                        <div class="row"><span class="row-label">Winbox</span><span class="row-value"><span class="badge">${host}:${router.ports.winbox}</span></span></div>
                        <div class="row"><span class="row-label">SSH</span><span class="row-value"><span class="badge">${host}:${router.ports.ssh}</span></span></div>
                        <div class="row"><span class="row-label">API</span><span class="row-value"><span class="badge">${host}:${router.ports.api}</span></span></div>
                    </div>

                    <p style="margin-top: 18px;">You can now start using your router. Need a hand? Just reply to this email.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Router is Online!

Hello ${user.name},

Great news! Your MikroTik router "${router.name}" is now online and connected to the VPN.

Router Details:
- Name: ${router.name}
- Status: ${router.status}
- Connected At: ${new Date(router.lastSeen).toLocaleString()}

Access Your Router:
- Winbox: ${host}:${router.ports.winbox}
- SSH: ${host}:${router.ports.ssh}
- API: ${host}:${router.ports.api}

You can now start using your router. If you need any assistance, just reply to this email.

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: `Router Online: ${router.name} - Blackie Networks`,
        htmlContent,
        textContent
    });
}

/**
 * Send router deleted notification email
 */
async function sendRouterDeletedEmail(user, router) {
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #f44336; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background-color: #f9f9f9; }
                .info-box { background-color: white; padding: 15px; margin: 10px 0; border-left: 4px solid #f44336; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Router Deleted</h1>
                </div>
                <div class="content">
                    <h2>Router Removal Confirmation</h2>
                    <p>Hello ${user.name},</p>
                    <p>This email confirms that your MikroTik router <strong>${router.name}</strong> has been successfully deleted from your account.</p>
                    
                    <div class="info-box">
                        <h3>Deleted Router Details:</h3>
                        <p><strong>Name:</strong> ${router.name}</p>
                        <p><strong>Deleted At:</strong> ${new Date().toLocaleString()}</p>
                    </div>

                    <p><strong>What this means:</strong></p>
                    <ul>
                        <li>The router configuration has been removed</li>
                        <li>All associated ports have been released</li>
                        <li>WireGuard connection has been terminated</li>
                        <li>Billing for this router will stop</li>
                    </ul>

                    <p>If you did not request this deletion, please contact support immediately.</p>
                    <p>If you have any questions, please don't hesitate to reach out to our support team.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Router Deleted

Hello ${user.name},

This email confirms that your MikroTik router "${router.name}" has been successfully deleted from your account.

Deleted Router Details:
- Name: ${router.name}
- Deleted At: ${new Date().toLocaleString()}

What this means:
- The router configuration has been removed
- All associated ports have been released
- WireGuard connection has been terminated
- Billing for this router will stop

If you did not request this deletion, please contact support immediately.

If you have any questions, please don't hesitate to reach out to our support team.

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: `Router Deleted: ${router.name} - Blackie Networks`,
        htmlContent,
        textContent
    });
}

/**
 * Send invoice/receipt email for a completed billing charge (first paid
 * router, trial-to-paid conversion, or monthly renewal). Not sent for $0
 * trial-start transactions - sendRouterCreatedEmail already covers that.
 */
async function sendInvoiceEmail(user, transaction) {
    const invoiceDate = new Date(transaction.createdAt || Date.now()).toLocaleString();
    const amount = Number(transaction.amount || 0).toFixed(2);

    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #2196F3; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background-color: #f9f9f9; }
                .info-box { background-color: white; padding: 15px; margin: 10px 0; border-left: 4px solid #2196F3; }
                .amount { font-size: 28px; font-weight: bold; color: #2196F3; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Invoice from Blackie Networks</h1>
                </div>
                <div class="content">
                    <h2>Payment Receipt</h2>
                    <p>Hello ${user.name},</p>
                    <p>This confirms a payment of <strong>$${amount}</strong> was charged to your Blackie Networks wallet balance.</p>

                    <div class="info-box">
                        <h3>Invoice Details:</h3>
                        <p><strong>Invoice #:</strong> ${transaction.transactionId}</p>
                        <p><strong>Description:</strong> ${transaction.description}</p>
                        <p><strong>Date:</strong> ${invoiceDate}</p>
                        <p class="amount">$${amount}</p>
                    </div>

                    <p>You can view your full billing history and download past invoices anytime from the Billing page in your dashboard.</p>
                    <p>If you have any questions about this charge, please contact support.</p>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Invoice from Blackie Networks

Hello ${user.name},

This confirms a payment of $${amount} was charged to your Blackie Networks wallet balance.

Invoice Details:
- Invoice #: ${transaction.transactionId}
- Description: ${transaction.description}
- Date: ${invoiceDate}
- Amount: $${amount}

You can view your full billing history and download past invoices anytime from the Billing page in your dashboard.

If you have any questions about this charge, please contact support.

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: `Invoice ${transaction.transactionId} - Blackie Networks`,
        htmlContent,
        textContent
    });
}

/**
 * Send password reset email
 */
async function sendPasswordResetEmail(user, token) {
    const resetUrl = `${FRONTEND_URL}/reset-password?token=${token}`;
    
    const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <style>
                body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
                .container { max-width: 600px; margin: 0 auto; padding: 20px; }
                .header { background-color: #2196F3; color: white; padding: 20px; text-align: center; }
                .content { padding: 20px; background-color: #f9f9f9; }
                .button { display: inline-block; padding: 12px 24px; background-color: #2196F3; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
                .warning { background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 15px 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <h1>Password Reset Request</h1>
                </div>
                <div class="content">
                    <h2>Reset Your Password</h2>
                    <p>Hello ${user.name},</p>
                    <p>We received a request to reset your password. Click the button below to reset it:</p>
                    <a href="${resetUrl}" class="button">Reset Password</a>
                    <p>Or copy and paste this link into your browser:</p>
                    <p style="word-break: break-all;">${resetUrl}</p>
                    <div class="warning">
                        <p><strong>⚠️ Important:</strong></p>
                        <ul>
                            <li>This link will expire in 1 hour</li>
                            <li>If you didn't request this, please ignore this email</li>
                            <li>Your password will remain unchanged if you don't click the link</li>
                        </ul>
                    </div>
                </div>
                <div class="footer">
                    <p>&copy; ${new Date().getFullYear()} Blackie Networks. All rights reserved.</p>
                </div>
            </div>
        </body>
        </html>
    `;

    const textContent = `
Password Reset Request

Hello ${user.name},

We received a request to reset your password. Visit the link below to reset it:

${resetUrl}

⚠️ Important:
- This link will expire in 1 hour
- If you didn't request this, please ignore this email
- Your password will remain unchanged if you don't click the link

© ${new Date().getFullYear()} Blackie Networks. All rights reserved.
    `;

    return sendEmail({
        to: user.email,
        subject: 'Reset Your Password - Blackie Networks',
        htmlContent,
        textContent
    });
}

module.exports = {
    sendEmail,
    sendVerificationEmail,
    sendPasswordResetEmail,
    sendRouterCreatedEmail,
    sendRouterOnlineEmail,
    sendRouterDeletedEmail,
    sendInvoiceEmail
};
