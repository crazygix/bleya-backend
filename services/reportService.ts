import mongoose from 'mongoose';
import { Report, REPORT_REASONS } from '../models/Report.js';
import { User } from '../models/User.js';
import { ValidationError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

export interface CreateReportInput {
    reportedUserId?: unknown;
    roomId?: unknown;
    messageId?: unknown;
    reason?: unknown;
    details?: unknown;
}

export interface CreateReportResult {
    id: string;
    status: string;
    createdAt: number;
}

const REPORT_REASON_SET = new Set<string>(REPORT_REASONS);

function parseOptionalObjectId(value: unknown, fieldName: string): mongoose.Types.ObjectId | undefined {
    if (value === undefined || value === null || value === '') {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new ValidationError(`${fieldName} must be a string.`);
    }
    return validateObjectId(value, fieldName);
}

export async function createReport(
    reporterUserId: string,
    input: CreateReportInput
): Promise<CreateReportResult> {
    if (typeof input.reason !== 'string' || !REPORT_REASON_SET.has(input.reason)) {
        throw new ValidationError(`reason must be one of: ${REPORT_REASONS.join(', ')}.`);
    }

    const reportedUserId = parseOptionalObjectId(input.reportedUserId, 'reported user ID');
    const roomId = parseOptionalObjectId(input.roomId, 'room ID');
    const messageId = parseOptionalObjectId(input.messageId, 'message ID');

    if (!reportedUserId && !roomId && !messageId) {
        throw new ValidationError('A report must reference a user, a room, or a message.');
    }

    if (reportedUserId && reportedUserId.toString() === reporterUserId) {
        throw new ValidationError("You can't report yourself.");
    }

    if (reportedUserId) {
        const reportedExists = await User.exists({ _id: reportedUserId });
        if (!reportedExists) {
            throw new NotFoundError('User not found', ErrorCode.USER_NOT_FOUND);
        }
    }

    const details = typeof input.details === 'string'
        ? sanitizePlainText(input.details, { maxLength: 1000, collapseWhitespace: false, escapeHtml: true })
        : '';

    const report = await Report.create({
        reporterUserId: new mongoose.Types.ObjectId(reporterUserId),
        reportedUserId,
        roomId,
        messageId,
        reason: input.reason,
        details,
    });

    logger.info('report.created', {
        reportId: report._id.toString(),
        reporterUserId,
        reason: input.reason,
        hasReportedUser: !!reportedUserId,
        hasMessage: !!messageId,
        hasRoom: !!roomId,
    });

    return {
        id: report._id.toString(),
        status: report.status as string,
        createdAt: (report.createdAt as Date).getTime(),
    };
}
