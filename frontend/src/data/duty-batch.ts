/** 批量排班台的数据层：批次独立存一份 localStorage，与通用条目表分开。 */
import type { EntryRow } from './types'

export type ConflictSeverity = 'block' | 'warn' | 'info'

export type ConflictType =
  | 'self-overlap' // 同一批次内人员同时段被排到多个岗位
  | 'existing' // 与已写入的排班人员重叠
  | 'pending-batch' // 与其它待确认批次重叠
  | 'transfer-wins' // 原始班次已被已生效调班调整，调班优先
  | 'handover' // 与已交接记录相遇，只提示不阻塞
  | 'cross-month' // 跨月排班提示

export interface DutyConflict {
  severity: ConflictSeverity
  type: ConflictType
  message: string
  refBatchNo?: string
  refDutyNo?: string
}

export interface DutyPlanEntry {
  /** 批次内条目的稳定标识：日期|时段|岗位|人员 */
  localId: string
  date: string
  slot: string
  post: string
  person: string
  conflicts: DutyConflict[]
}

export interface DutyBatch {
  id: number
  batchNo: string
  fingerprint: string
  status: '待确认' | '已确认' | '已作废'
  createdAt: string
  confirmedAt?: string
  /** 批次跨的月份，如 2026-09 / 2026-10 */
  months: string[]
  crossMonth: boolean
  entries: DutyPlanEntry[]
  /** 确认后落账的痕迹，便于从批次追溯到三张表 */
  dutyNos?: string[]
  standbyNo?: string
  checkpointNo?: string
}

const STORAGE_KEY = 'forest-fire-patrol:duty-batches'

function readStorage(): DutyBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as DutyBatch[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

let cache: DutyBatch[] | null = null

export function allBatches(): DutyBatch[] {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function saveBatches(batches: DutyBatch[]): void {
  cache = batches
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(batches))
  }
}

export function nextBatchId(): number {
  return allBatches().reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
}

/** 条目的去重指纹：同内容提交只保留一份。 */
export function fingerprintOf(
  picked: Array<{ date: string; slot: string; post: string; person: string }>,
): string {
  return picked
    .map((item) => `${item.date}|${item.slot}|${item.post}|${item.person}`)
    .sort()
    .join(';')
}

export function makeEntry(
  date: string,
  slot: string,
  post: string,
  person: string,
): DutyPlanEntry {
  return { localId: `${date}|${slot}|${post}|${person}`, date, slot, post, person, conflicts: [] }
}

/** 取某张表当前最大数字 id + 1，供确认后向三张业务表追加记录。 */
export function nextRowId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}
