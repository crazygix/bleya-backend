import mongoose from 'mongoose';
import { config } from '../config/index.js';
import { ModerationAction, ModerationTargetType } from '../models/ModerationAction.js';
import logger from '../utils/logger.js';
import { retainUntilAfter } from '../utils/retention.js';

export interface RecordActionInput {
    actorLabel: string;
    action: string;
    targetType: ModerationTargetType;
    targetId: string | mongoose.Types.ObjectId;
    reportId?: string | mongoose.Types.ObjectId | null;
    reason?: string;
    metadata?: Record<string, unknown>;
}

function toObjectId(value: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
    return typeof value === 'string' ? new mongoose.Types.ObjectId(value) : value;
}

// Best-effort: never let an audit-log failure break the moderator action itself.
export async function recordModerationAction(input: RecordActionInput): Promise<void> {
    try {
        await ModerationAction.create({
            actorLabel: input.actorLabel,
            action: input.action,
            targetType: input.targetType,
            targetId: toObjectId(input.targetId),
            reportId: input.reportId ? toObjectId(input.reportId) : undefined,
            reason: input.reason || '',
            metadata: input.metadata,
            retainUntil: retainUntilAfter(config.auditLog.retentionDays),
        });
    } catch (error) {
        logger.error('audit.record_failed', {
            action: input.action,
            targetType: input.targetType,
            error: error instanceof Error ? error.message : 'unknown',
        });
    }
}

export interface ListActionsQuery {
    targetId?: string;
    actorLabel?: string;
    page?: number;
    pageSize?: number;
}

export interface PaginatedResult<T> {
    data: T[];
    page: number;
    pageSize: number;
    total: number;
}

interface ModerationActionDTO {
    id: string;
    actorLabel: string;
    action: string;
    targetType: string;
    targetId: string;
    reportId: string | null;
    reason: string;
    metadata: unknown;
    createdAt: number;
}

export async function listModerationActions(query: ListActionsQuery): Promise<PaginatedResult<ModerationActionDTO>> {
    const page = Math.max(1, Math.floor(query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Math.floor(query.pageSize || 50)));

    const filter: Record<string, unknown> = {};
    if (query.targetId && mongoose.Types.ObjectId.isValid(query.targetId)) {
        filter.targetId = new mongoose.Types.ObjectId(query.targetId);
    }
    if (query.actorLabel) {
        filter.actorLabel = query.actorLabel;
    }

    const [items, total] = await Promise.all([
        ModerationAction.find(filter)
            .sort({ createdAt: -1 })
            .skip((page - 1) * pageSize)
            .limit(pageSize)
            .lean(),
        ModerationAction.countDocuments(filter),
    ]);

    const data: ModerationActionDTO[] = items.map((item) => ({
        id: (item._id as mongoose.Types.ObjectId).toString(),
        actorLabel: (item.actorLabel as string) || '',
        action: (item.action as string) || '',
        targetType: (item.targetType as string) || '',
        targetId: item.targetId ? (item.targetId as mongoose.Types.ObjectId).toString() : '',
        reportId: item.reportId ? (item.reportId as mongoose.Types.ObjectId).toString() : null,
        reason: (item.reason as string) || '',
        metadata: item.metadata ?? null,
        createdAt: item.createdAt ? (item.createdAt as Date).getTime() : 0,
    }));

    return { data, page, pageSize, total };
}
