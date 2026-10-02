import { listRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  BatchSubmitResult,
  DutyBatch,
  DutyBatchEntry,
  DutyConflict,
  EntryRow,
} from '@/data/types'

// 批量排班台的数据服务：批次单独存一个 localStorage 键，不动通用条目库。
// 冲突优先级约定：跨月排班与交接记录冲突时「调班申请优先」——调班申请是最新的、
// 明确的人员安排意图，原班次的交接记录是历史结果；确认批次时把被覆盖的原班次
// 标记为「已调班」，交接记录并入新班次，避免同一时段两套人马。
const BATCH_STORAGE_KEY = 'forest-fire-patrol:duty-batches'
const DUTY_KEY = 'duty'
const FIRETEAM_KEY = 'fireteam'
const CHECKPOINT_KEY = 'checkpoint'

export const DUTY_PERIODS = ['白班 08:00-16:00', '小夜班 16:00-24:00', '大夜班 00:00-08:00']
export const DUTY_POSITIONS = ['指挥中心值守', '瞭望塔值守', '防火检查站值守', '巡逻机动岗', '电台通讯岗']
export const DUTY_ROSTER = ['王海峰', '李秀兰', '张建国', '赵春梅', '刘志强', '陈立冬', '孙向阳', '周雪梅']

const MAX_RANGE_DAYS = 31

export type BatchInput = {
  dates: string[]
  periods: string[]
  positions: string[]
  persons: string[]
  接班人员?: string
}

function readBatches(): DutyBatch[] {
  if (typeof window === 'undefined' || !window.localStorage) {
    return []
  }
  const raw = window.localStorage.getItem(BATCH_STORAGE_KEY)
  if (!raw) {
    return []
  }
  try {
    return JSON.parse(raw) as DutyBatch[]
  } catch {
    return []
  }
}

function saveBatches(batches: DutyBatch[]): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(BATCH_STORAGE_KEY, JSON.stringify(batches))
  }
}

export function listBatches(): DutyBatch[] {
  return readBatches().sort((a, b) => b.id - a.id)
}

/** 起止日期生成逐日列表（含两端），超过 31 天截断，防止误选整年。 */
export function datesBetween(start: string, end: string): string[] {
  if (!start || !end) {
    return []
  }
  const first = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  if (Number.isNaN(first.getTime()) || Number.isNaN(last.getTime()) || first > last) {
    return []
  }
  const days: string[] = []
  const cursor = new Date(first)
  while (cursor <= last && days.length < MAX_RANGE_DAYS) {
    const mm = String(cursor.getMonth() + 1).padStart(2, '0')
    const dd = String(cursor.getDate()).padStart(2, '0')
    days.push(`${cursor.getFullYear()}-${mm}-${dd}`)
    cursor.setDate(cursor.getDate() + 1)
  }
  return days
}

/** 已调班的记录是被覆盖的历史班次，不再参与人员重叠检查。 */
function isActiveDuty(row: EntryRow): boolean {
  return String(row.status) !== '已调班'
}

function sameSlot(row: EntryRow, entry: Pick<DutyBatchEntry, '值勤日期' | '值勤时段'>): boolean {
  return String(row['值勤日期']) === entry.值勤日期 && String(row['值勤时段']) === entry.值勤时段
}

function detectConflicts(
  entry: DutyBatchEntry,
  existingRows: EntryRow[],
  batchSlots: Set<string>,
  crossMonth: boolean,
): DutyConflict[] {
  const conflicts: DutyConflict[] = []
  // 人员重叠：同一值勤日期 + 值勤时段，同一人已有在岗排班（无论岗位）。
  for (const row of existingRows) {
    if (isActiveDuty(row) && sameSlot(row, entry) && String(row['值勤人员']) === entry.值勤人员) {
      conflicts.push({
        kind: '人员重叠',
        detail: `${entry.值勤人员} 在此时段已有排班 ${String(row['排班编号'])}（${String(row['值勤岗位'])}）`,
        withEntryId: Number(row.id),
      })
    }
  }
  if (batchSlots.has(`${entry.值勤日期}|${entry.值勤时段}|${entry.值勤人员}`)) {
    conflicts.push({ kind: '人员重叠', detail: '本批次内同一人员在该日期时段重复出现' })
  }
  // 跨月交接冲突：批次跨月，且同一日期时段岗位上已有带交接结果的班次。
  if (crossMonth) {
    for (const row of existingRows) {
      if (!sameSlot(row, entry) || String(row['值勤岗位']) !== entry.值勤岗位) {
        continue
      }
      const handover = String(row['交接记录'] ?? '').trim()
      if (handover || row.status === '已交接' || row.status === '值勤中') {
        conflicts.push({
          kind: '跨月交接冲突',
          detail: `原班次 ${String(row['排班编号'])} 已有交接记录，确认时按调班申请优先处理`,
          withEntryId: Number(row.id),
        })
      }
    }
  }
  return conflicts
}

/** 生成批次预览：日期 × 时段 × 岗位 × 人员逐条展开并检查冲突，人员重叠的默认剔除。 */
export function buildBatchEntries(input: BatchInput): { entries: DutyBatchEntry[]; crossMonth: boolean } {
  const dates = [...input.dates].sort()
  const crossMonth = new Set(dates.map((d) => d.slice(0, 7))).size > 1
  const existingRows = listRows(DUTY_KEY)
  const batchSlots = new Set<string>()
  const entries: DutyBatchEntry[] = []
  for (const 值勤日期 of dates) {
    for (const 值勤时段 of input.periods) {
      for (const 值勤岗位 of input.positions) {
        for (const 值勤人员 of input.persons) {
          const entry: DutyBatchEntry = {
            key: `${值勤日期}|${值勤时段}|${值勤岗位}|${值勤人员}`,
            值勤日期,
            值勤时段,
            值勤岗位,
            值勤人员,
            接班人员: input.接班人员 ?? '',
            conflicts: [],
            excluded: false,
          }
          entry.conflicts = detectConflicts(entry, existingRows, batchSlots, crossMonth)
          entry.excluded = entry.conflicts.some((item) => item.kind === '人员重叠')
          entries.push(entry)
          batchSlots.add(`${值勤日期}|${值勤时段}|${值勤人员}`)
        }
      }
    }
  }
  return { entries, crossMonth }
}

function fingerprintOf(entries: DutyBatchEntry[]): string {
  return entries.map((entry) => entry.key).sort().join(';')
}

function nowString(): string {
  return new Date().toLocaleString('zh-CN', { hour12: false })
}

/** 提交批次：同一选择（指纹相同）重复提交只保留一份，直接返回已存在的批次。 */
export function submitBatch(entries: DutyBatchEntry[], crossMonth: boolean): BatchSubmitResult {
  if (!entries.length) {
    return { ok: false, duplicated: false, message: '没有选择任何日期、时段、岗位或人员' }
  }
  const fingerprint = fingerprintOf(entries)
  const batches = readBatches()
  const existing = batches.find((batch) => batch.fingerprint === fingerprint)
  if (existing) {
    return {
      ok: true,
      duplicated: true,
      message: `批次 ${existing.批次号} 已存在（${existing.status}），同一批次只保留一份`,
      batch: existing,
    }
  }
  const id = batches.reduce((max, batch) => Math.max(max, batch.id), 0) + 1
  const batch: DutyBatch = {
    id,
    批次号: `DUTB-${String(id).padStart(4, '0')}`,
    fingerprint,
    提交时间: nowString(),
    跨月: crossMonth,
    status: '待确认',
    entries,
  }
  saveBatches([...batches, batch])
  const conflictCount = entries.filter((entry) => entry.conflicts.length > 0).length
  const included = entries.filter((entry) => !entry.excluded).length
  return {
    ok: true,
    duplicated: false,
    message: `批次 ${batch.批次号} 已提交待确认：共 ${entries.length} 条，待写入 ${included} 条，${conflictCount} 条有冲突可逐条查看`,
    batch,
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1
}

/**
 * 确认批次：写入前再按值勤日期 + 值勤时段检查一次人员重叠，重叠条目跳过；
 * 跨月交接冲突按调班申请优先，原班次标记已调班、交接记录并入新班次；
 * 最后在扑火队伍待命表和防火检查站换岗清单各落一条联动记录（按批次号去重）。
 */
export function confirmBatch(id: number): ActionResult {
  const batches = readBatches()
  const batch = batches.find((item) => item.id === id)
  if (!batch) {
    return { ok: false, message: `没有找到编号为 ${id} 的排班批次` }
  }
  if (batch.status === '已确认') {
    return { ok: false, message: `批次 ${batch.批次号} 已确认过，不用重复操作` }
  }
  const included = batch.entries.filter((entry) => !entry.excluded)
  if (!included.length) {
    return { ok: false, message: `批次 ${batch.批次号} 没有可写入的条目，全部已被剔除` }
  }

  const dutyRows = listRows(DUTY_KEY)
  const written: EntryRow[] = []
  let skipped = 0
  let seq = nextId(dutyRows) - 1

  for (const entry of batch.entries) {
    if (entry.excluded) {
      entry.resolution = '提交时已剔除，未写入'
      continue
    }
    // 写入前检查：同一值勤日期 + 值勤时段的人员重叠，以确认时刻的数据为准。
    const overlap = [...dutyRows, ...written].find(
      (row) => isActiveDuty(row) && sameSlot(row, entry) && String(row['值勤人员']) === entry.值勤人员,
    )
    if (overlap) {
      entry.resolution = `写入前检查发现与 ${String(overlap['排班编号'])} 人员重叠，未写入`
      skipped += 1
      continue
    }
    // 跨月交接冲突：调班申请优先，原班次标记已调班，交接记录并入新班次。
    const handoverConflict = entry.conflicts.find((item) => item.kind === '跨月交接冲突')
    let 交接记录 = ''
    if (handoverConflict?.withEntryId !== undefined) {
      const origin = dutyRows.find((row) => Number(row.id) === handoverConflict.withEntryId)
      if (origin && isActiveDuty(origin)) {
        origin.status = '已调班'
        origin['排班状态'] = '已调班'
        const note = `跨月冲突按调班申请优先，交接并入批次 ${batch.批次号}`
        origin['交接记录'] = [String(origin['交接记录'] ?? '').trim(), note].filter(Boolean).join('；')
        交接记录 = `承接 ${String(origin['排班编号'])} 的交接（调班申请优先）`
        entry.resolution = `调班申请优先：原班次 ${String(origin['排班编号'])} 已调班`
      }
    }
    seq += 1
    const 排班编号 = `DUTY-${String(seq).padStart(4, '0')}`
    written.push({
      id: seq,
      status: '已确认',
      pending: true,
      abnormal: false,
      排班编号,
      值勤日期: entry.值勤日期,
      值勤时段: entry.值勤时段,
      值勤岗位: entry.值勤岗位,
      值勤人员: entry.值勤人员,
      接班人员: entry.接班人员 || '—',
      交接记录,
      排班状态: '已确认',
      批次号: batch.批次号,
    })
    entry.resolution = entry.resolution ?? `已写入 ${排班编号}`
  }
  saveRows(DUTY_KEY, [...dutyRows, ...written])

  const dates = included.map((entry) => entry.值勤日期).sort()
  const firstDate = dates[0] ?? ''
  const persons = [...new Set(included.map((entry) => entry.值勤人员))]

  // 联动一：扑火队伍待命表落一条，按批次号去重，重复确认不会落两条。
  const teamRows = listRows(FIRETEAM_KEY)
  let teamRow = teamRows.find((row) => row['联动批次号'] === batch.批次号)
  if (!teamRow) {
    const id = nextId(teamRows)
    teamRow = {
      id,
      status: '在营待命',
      pending: true,
      abnormal: false,
      队伍编号: `FIRE-${String(id).padStart(4, '0')}`,
      队伍名称: `值勤联动待命队（${batch.批次号}）`,
      所属林场: '场部',
      队长姓名: persons[0] ?? '—',
      队员人数: persons.length,
      集结半径: '30分钟',
      值班状态: `${firstDate} 起随值勤批次待命`,
      出动状态: '在营待命',
      联动批次号: batch.批次号,
    }
    saveRows(FIRETEAM_KEY, [...teamRows, teamRow])
  }
  batch.联动扑火队伍id = Number(teamRow.id)

  // 联动二：防火检查站换岗清单落一条，同样按批次号去重。
  const checkpointRows = listRows(CHECKPOINT_KEY)
  let checkpointRow = checkpointRows.find((row) => row['联动批次号'] === batch.批次号)
  if (!checkpointRow) {
    const id = nextId(checkpointRows)
    checkpointRow = {
      id,
      status: '等待换岗',
      pending: true,
      abnormal: false,
      站点编号: `CHEC-${String(id).padStart(4, '0')}`,
      站点位置: '场部门口检查站',
      值守人员: persons[0] ?? '—',
      检查项目: '入山火种检查',
      通行车辆数: 0,
      收缴火种数: 0,
      值班日期: firstDate,
      运行状态: '等待换岗',
      联动批次号: batch.批次号,
    }
    saveRows(CHECKPOINT_KEY, [...checkpointRows, checkpointRow])
  }
  batch.联动检查站id = Number(checkpointRow.id)

  batch.status = '已确认'
  saveBatches(batches)
  return {
    ok: true,
    message: `批次 ${batch.批次号} 已确认：写入排班 ${written.length} 条、重叠跳过 ${skipped} 条；扑火队伍待命表与防火检查站换岗清单各落一条`,
  }
}
