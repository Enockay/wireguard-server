const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const SUPPORT_UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'support');

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeFilename(filename) {
    const base = String(filename || 'attachment')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/_+/g, '_');
    return base || 'attachment';
}

function inferExtension(contentType = '') {
    const map = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'application/pdf': '.pdf',
        'text/plain': '.txt',
        'application/json': '.json'
    };
    return map[contentType] || '';
}

function normalizeIncomingAttachments(attachments) {
    if (!Array.isArray(attachments)) return [];
    return attachments.slice(0, MAX_ATTACHMENTS).filter(Boolean);
}

function storeSupportAttachments(ticketId, attachments = []) {
    const normalized = normalizeIncomingAttachments(attachments);
    if (!normalized.length) return [];

    const ticketDir = path.join(SUPPORT_UPLOAD_ROOT, String(ticketId));
    ensureDir(ticketDir);

    return normalized.map((attachment) => {
        const filename = sanitizeFilename(attachment.filename);
        const raw = attachment.dataBase64 || attachment.data || '';
        const contentType = String(attachment.contentType || attachment.mimeType || 'application/octet-stream');
        const buffer = Buffer.from(String(raw), 'base64');
        if (!buffer.length) {
            throw new Error(`Attachment "${filename}" is empty or invalid`);
        }
        if (buffer.length > MAX_ATTACHMENT_BYTES) {
            throw new Error(`Attachment "${filename}" exceeds the 5MB limit`);
        }

        const uniquePrefix = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const extension = path.extname(filename) || inferExtension(contentType);
        const storedName = `${uniquePrefix}-${sanitizeFilename(path.basename(filename, path.extname(filename)))}${extension}`;
        const absolutePath = path.join(ticketDir, storedName);
        fs.writeFileSync(absolutePath, buffer);

        return {
            filename,
            url: `/uploads/support/${ticketId}/${storedName}`,
            size: buffer.length,
            contentType,
            storedName
        };
    });
}

module.exports = {
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_BYTES,
    SUPPORT_UPLOAD_ROOT,
    storeSupportAttachments
};
