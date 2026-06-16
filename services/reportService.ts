import mongoose from 'mongoose';
import { Report, REPORT_REASONS, REPORT_STATUSES } from '../models/Report.js';
import { User } from '../models/User.js';
import { ValidationError, NotFoundError, ErrorCode } from '../utils/errors.js';
import { validateObjectId } from '../utils/validation.js';
import { sanitizePlainText } from '../utils/sanitize.js';
import { recordModerationAction } from './auditService.js';
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

// ---------------------------------------------------------------------------
// Admin moderation (consumed by /v1/admin/reports — the future web panel)
// ---------------------------------------------------------------------------

const REPORT_STATUS_SET = new Set<string>(REPORT_STATUSES);

export interface ListReportsQuery {
    status?: string;
    reason?: string;
    targetType?: string; // 'user' | 'room' | 'message'
    page?: number;
    pageSize?: number;
}

export interface PaginatedResult<T> {
    data: T[];
    page: number;
    pageSize: number;
    total: number;
}

export interface ReportListItem {
    id: string;
    status: string;
    reason: string;
    details: string;
    reporter: { id: string | null; username: string | null };
    reportedUser: { id: string | null; username: string | null };
    roomId: string | null;
    messageId: string | null;
    reviewedBy: string;
    reviewedAt: number | null;
    createdAt: number;
}

export interface ReportDetail extends ReportListItem {
    resolutionNote: string;
    room: { id: string | null; name: string | null };
    message: {
        id: string | null;
        text: string | null;
        deleted: boolean;
        author: { id: string | null; username: string | null };
        roomId: string | null;
        createdAt: number | null;
    } | null;
}

function refId(ref: unknown): string | null {
    if (!ref) return null;
    if (ref instanceof mongoose.Types.ObjectId) return ref.toString();
    if (typeof ref === 'object' && ref !== null && '_id' in (ref as Record<string, unknown>)) {
        return ((ref as { _id: mongoose.Types.ObjectId })._id).toString();
    }
    return null;
}

function refField(ref: unknown, field: string): string | null {
    if (ref && typeof ref === 'object' && field in (ref as Record<string, unknown>)) {
        const value = (ref as Record<string, unknown>)[field];
        return typeof value === 'string' && value.length > 0 ? value : null;
    }
    return null;
}

function toMs(value: unknown): number | null {
    return value instanceof Date ? value.getTime() : null;
}

function formatReportListItem(r: Record<string, any>): ReportListItem {
    return {
        id: r._id.toString(),
        status: r.status,
        reason: r.reason,
        details: r.details || '',
        reporter: { id: refId(r.reporterUserId), username: refField(r.reporterUserId, 'username') },
        reportedUser: { id: refId(r.reportedUserId), username: refField(r.reportedUserId, 'username') },
        roomId: refId(r.roomId),
        messageId: refId(r.messageId),
        reviewedBy: r.reviewedBy || '',
        reviewedAt: toMs(r.reviewedAt),
        createdAt: toMs(r.createdAt) ?? 0,
    };
}

export async function listReports(query: ListReportsQuery): Promise<PaginatedResult<ReportListItem>> {
    const page = Math.max(1, Math.floor(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 50)));

    const filter: Record<string, unknown> = {};
    if (query.status) {
        if (!REPORT_STATUS_SET.has(query.status)) {
            throw new ValidationError(`status must be one of: ${REPORT_STATUSES.join(', ')}.`);
        }
        filter.status = query.status;
    }
    if (query.reason) {
        if (!REPORT_REASON_SET.has(query.reason)) {
            throw new ValidationError(`reason must be one of: ${REPORT_REASONS.join(', ')}.`);
        }
        filter.reason = query.reason;
    }
    if (query.targetType === 'user') filter.reportedUserId = { $ne: null };
    else if (query.targetType === 'room') filter.roomId = { $ne: null };
    else if (query.targetType === 'message') filter.messageId = { $ne: null };

    const [items, total] = await Promise.all([
        Report.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .populate('reporterUserId', 'username')
            .populate('reportedUserId', 'username')
            .lean(),
        Report.countDocuments(filter),
    ]);

    return {
        data: (items as Record<string, any>[]).map(formatReportListItem),
        page,
        pageSize,
        total,
    };
}

export async function getReport(reportId: string): Promise<ReportDetail> {
    const id = validateObjectId(reportId, 'report ID');

    // Admin view intentionally does NOT filter soft-deleted messages — a
    // moderator must be able to see content even after it's been removed.
    const report = await Report.findById(id)
        .populate('reporterUserId', 'username')
        .populate('reportedUserId', 'username')
        .populate('roomId', 'name')
        .populate({
            path: 'messageId',
            select: 'text userId roomId createdAt deletedAt',
            populate: { path: 'userId', select: 'username' },
        })
        .lean();

    if (!report) {
        throw new NotFoundError('Report not found');
    }

    const r = report as Record<string, any>;
    const message = r.messageId && typeof r.messageId === 'object'
        ? {
            id: refId(r.messageId),
            text: typeof r.messageId.text === 'string' ? r.messageId.text : null,
            deleted: !!r.messageId.deletedAt,
            author: { id: refId(r.messageId.userId), username: refField(r.messageId.userId, 'username') },
            roomId: refId(r.messageId.roomId),
            createdAt: toMs(r.messageId.createdAt),
        }
        : null;

    return {
        ...formatReportListItem(r),
        resolutionNote: r.resolutionNote || '',
        room: { id: refId(r.roomId), name: refField(r.roomId, 'name') },
        message,
    };
}

export async function updateReportStatus(
    reportId: string,
    status: unknown,
    actorLabel: string,
    note?: unknown
): Promise<ReportDetail> {
    const id = validateObjectId(reportId, 'report ID');
    if (typeof status !== 'string' || !REPORT_STATUS_SET.has(status)) {
        throw new ValidationError(`status must be one of: ${REPORT_STATUSES.join(', ')}.`);
    }

    const resolutionNote = typeof note === 'string'
        ? sanitizePlainText(note, { maxLength: 1000, collapseWhitespace: false, escapeHtml: true })
        : '';

    const updated = await Report.findByIdAndUpdate(
        id,
        { $set: { status, reviewedBy: actorLabel, reviewedAt: new Date(), resolutionNote } },
        { new: true }
    );

    if (!updated) {
        throw new NotFoundError('Report not found');
    }

    await recordModerationAction({
        actorLabel,
        action: 'report_status_changed',
        targetType: 'report',
        targetId: id,
        reportId: id,
        reason: resolutionNote,
        metadata: { status },
    });

    logger.info('report.status_changed', {
        reportId: updated._id.toString(),
        status,
        actor: actorLabel,
    });

    return getReport(reportId);
}
