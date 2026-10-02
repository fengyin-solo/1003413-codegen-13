import {
  allBatches,
  fingerprintOf,
  makeEntry,
  nextBatchId,
  nextRowId,
  saveBatches,
} from '@/data/duty-batch'
import type { DutyBatch, DutyConflict, DutyPlanEntry } from '@/data/duty-batch'
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 可选值勤时段：跨月、跨夜由日期直接表达，时段固定四类，便于按「日期+时段」判重。
export const DUTY_SLOTS = ['白班', '夜班', '全天', '备班']

// 批量台给的默认岗位与人员候选；同时会合并历史排班里已出现过的值。
const FALLBACK_POSTS = ['瞭望台值勤', '检查站值守', '巡护前哨', '扑火预备队', '应急指挥']
const FALLBACK_PERSONS = ['张卫国', '李春林', '王长青', '赵守山', '陈望火', '刘松涛']

// 排班状态：已调班＝已生效调班；已交接＝既成事实，只提示不阻塞。
const ACTIVE_STATUSES = ['待确认', '已确认', '值勤中', '已调班']

function personOf(row: EntryRow): string {
  // 已调班/已交接按接班人（实际占用时段的人）算；其余按原始值勤人员。
  return ['已调班', '已交接'].includes(String(row.status))
    ? String(row['接班人员'] ?? row['值勤人员'] ?? '')
    : String(row['值勤人员'] ?? '')
}

function monthOf(date: string): string {
  return date.slice(0, 7)
}

function monthsOf(entries: DutyPlanEntry[]): string[] {
  return [...new Set(entries.map((entry) => monthOf(entry.date)))].sort()
}

function batchOfNo(no: string): DutyBatch | undefined {
  return allBatches().find((batch) => batch.batchNo === no)
}

/** 对单条候选排班评估冲突；同批次内的重复由候选生成阶段去重，这里只做跨记录判定。 */
function evaluateEntry(
  candidate: DutyPlanEntry,
  selfBatch: DutyBatch,
  dutyRows: EntryRow[],
  batches: DutyBatch[],
): DutyConflict[] {
  const conflicts: DutyConflict[] = []

  // 1) 同批次内：同一人在同一日期+时段被排到不同岗位。
  const sameSlotInBatch = selfBatch.entries.filter(
    (other) =>
      other.localId !== candidate.localId &&
      other.date === candidate.date &&
      other.slot === candidate.slot &&
      other.person === candidate.person,
  )
  if (sameSlotInBatch.length > 0) {
    const posts = sameSlotInBatch.map((entry) => entry.post).join('、')
    conflicts.push({
      severity: 'block',
      type: 'self-overlap',
      message: `${candidate.person} 在 ${candidate.date} ${candidate.slot} 还排了：${posts}，同人时段重叠`,
    })
  }

  // 2) 已写入排班表：按日期+时段+实际值勤人判重。
  for (const row of dutyRows) {
    if (String(row['值勤日期']) !== candidate.date || String(row['值勤时段']) !== candidate.slot) {
      continue
    }
    const status = String(row.status)
    const dutyNo = String(row['排班编号'] ?? row.id)
    const original = String(row['值勤人员'] ?? '')
    const successor = String(row['接班人员'] ?? '')

    if (status === '已调班') {
      // 已生效调班优先于原始班次：接班人占人（阻塞），原始班次本人已释放（仅说明）。
      if (successor && candidate.person === successor) {
        conflicts.push({
          severity: 'block',
          type: 'existing',
          message: `${candidate.person} 是 ${dutyNo} 已生效调班的接班人，在 ${candidate.date} ${candidate.slot} 已占用（调班优先）`,
          refDutyNo: dutyNo,
        })
      } else if (candidate.person === original) {
        conflicts.push({
          severity: 'info',
          type: 'transfer-wins',
          message: `${dutyNo} 的原始班次已由调班生效，${candidate.person} 已释放此时段，按调班申请优先，可重新排班`,
          refDutyNo: dutyNo,
        })
      }
      continue
    }

    if (status === '已交接') {
      // 已交接是既成事实，不阻塞新批次；命中本人时提醒核对交接记录。
      if (candidate.person === original || (successor && candidate.person === successor)) {
        conflicts.push({
          severity: 'warn',
          type: 'handover',
          message: `${dutyNo} 已交接完成（非阻塞），${candidate.person} 在 ${candidate.date} ${candidate.slot} 已有历史记录，请核对交接记录`,
          refDutyNo: dutyNo,
        })
      }
      continue
    }

    if (ACTIVE_STATUSES.includes(status) && personOf(row) === candidate.person) {
      conflicts.push({
        severity: 'block',
        type: 'existing',
        message: `${candidate.person} 在 ${candidate.date} ${candidate.slot} 已有排班 ${dutyNo}（${status}），人员重叠`,
        refDutyNo: dutyNo,
      })
    }
  }

  // 3) 其它待确认批次：提前占位，避免两批同时确认。
  for (const batch of batches) {
    if (batch.id === selfBatch.id || batch.status !== '待确认') {
      continue
    }
    const hit = batch.entries.find(
      (entry) =>
        entry.date === candidate.date &&
        entry.slot === candidate.slot &&
        entry.person === candidate.person,
    )
    if (hit) {
      conflicts.push({
        severity: 'block',
        type: 'pending-batch',
        message: `${candidate.person} 在 ${candidate.date} ${candidate.slot} 已在待确认批次 ${batch.batchNo} 中排到「${hit.post}」`,
        refBatchNo: batch.batchNo,
      })
    }
  }

  return conflicts
}

/** 重新评估批次内每条冲突，返回带冲突标记的新条目；跨月信息挂在批次上。 */
function evaluateBatch(batch: DutyBatch): DutyBatch {
  const dutyRows = listRows('duty')
  const batches = allBatches()
  let entries = batch.entries.map((entry) => ({
    ...entry,
    conflicts: evaluateEntry(entry, batch, dutyRows, batches),
  }))
  const months = monthsOf(entries)
  const crossMonth = months.length > 1
  if (crossMonth) {
    // 跨月排班：仍按值勤日期+时段判占，不因跨月放宽；优先规则在条目上提示清楚。
    const firstMonth = months[0]
    entries = entries.map((entry) =>
      monthOf(entry.date) !== firstMonth &&
      !entry.conflicts.some((conflict) => conflict.type === 'cross-month')
        ? {
            ...entry,
            conflicts: [
              ...entry.conflicts,
              {
                severity: 'info' as const,
                type: 'cross-month' as const,
                message: `跨月排班（${monthOf(entry.date)}）：仍按值勤日期+时段检查重叠；与交接记录冲突时已生效调班优先于原始班次`,
              },
            ],
          }
        : entry,
    )
  }
  return { ...batch, entries, months, crossMonth }
}

export interface BatchSummary {
  total: number
  blocked: number
  warned: number
  canConfirm: boolean
  hasCrossMonth: boolean
}

export function summarize(batch: DutyBatch): BatchSummary {
  const blocked = batch.entries.filter((entry) =>
    entry.conflicts.some((conflict) => conflict.severity === 'block'),
  ).length
  const warned = batch.entries.filter(
    (entry) =>
      entry.conflicts.some((conflict) => conflict.severity !== 'block') &&
      entry.conflicts.length > 0,
  ).length
  return {
    total: batch.entries.length,
    blocked,
    warned,
    canConfirm: blocked === 0 && batch.entries.length > 0 && batch.status === '待确认',
    hasCrossMonth: batch.crossMonth,
  }
}

/** 岗位/人员候选：默认值 ∪ 历史排班里出现过的有效值（剔除样例占位）。 */
function distinctFromRows(field: string, fallback: string[]): string[] {
  const fromRows = listRows('duty')
    .map((row) => String(row[field] ?? '').trim())
    .filter((value) => value !== '' && !value.includes('样例'))
  return [...new Set([...fallback, ...fromRows])].sort((a, b) => a.localeCompare(b, 'zh'))
}

export function dutyOptions(): { slots: string[]; posts: string[]; persons: string[] } {
  return {
    slots: DUTY_SLOTS,
    posts: distinctFromRows('值勤岗位', FALLBACK_POSTS),
    persons: distinctFromRows('值勤人员', FALLBACK_PERSONS),
  }
}

export interface SubmitResult {
  ok: boolean
  message: string
  batch?: DutyBatch
  duplicated?: boolean
}

/**
 * 一次提交形成待确认批次。
 * 幂等：同一份日期+时段+岗位+人员组合重复提交，只保留一份（返回原批次）。
 */
export function submitBatch(
  picked: Array<{ date: string; slot: string; post: string; person: string }>,
): SubmitResult {
  const valid = picked.filter(
    (item) => item.date && item.slot && item.post && item.person,
  )
  if (valid.length === 0) {
    return { ok: false, message: '请至少选择一个日期、时段、岗位和人员组合' }
  }

  // 组合层面先去重，同一条不会在批次内出现两次。
  const seen = new Set<string>()
  const entries: DutyPlanEntry[] = []
  for (const item of valid) {
    const key = fingerprintOf([item])
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    entries.push(makeEntry(item.date, item.slot, item.post, item.person))
  }

  const fingerprint = fingerprintOf(entries)
  const duplicate = allBatches().find(
    (batch) => batch.status !== '已作废' && batch.fingerprint === fingerprint,
  )
  if (duplicate) {
    return {
      ok: true,
      duplicated: true,
      batch: duplicate,
      message: `与批次 ${duplicate.batchNo}（${duplicate.status}）内容一致，重复提交只保留一份`,
    }
  }

  const id = nextBatchId()
  const seed: DutyBatch = {
    id,
    batchNo: `BATCH-${String(id).padStart(4, '0')}`,
    fingerprint,
    status: '待确认',
    createdAt: new Date().toISOString(),
    months: [],
    crossMonth: false,
    entries,
  }
  const evaluated = evaluateBatch(seed)
  saveBatches([...allBatches(), evaluated])
  return { ok: true, batch: evaluated, message: `已生成待确认批次 ${evaluated.batchNo}` }
}

export interface RemoveResult {
  ok: boolean
  message: string
  batch?: DutyBatch
}

/** 逐条处理冲突：从待确认批次移除某一条后重算剩余冲突。 */
export function removeEntry(batchId: number, localId: string): RemoveResult {
  const batches = allBatches()
  const index = batches.findIndex((batch) => batch.id === batchId)
  if (index < 0) {
    return { ok: false, message: '批次不存在' }
  }
  if (batches[index].status !== '待确认') {
    return { ok: false, message: '只有待确认批次可以逐条调整' }
  }
  const remaining = batches[index].entries.filter((entry) => entry.localId !== localId)
  const next: DutyBatch = { ...batches[index], entries: remaining }
  const evaluated = remaining.length === 0 ? { ...next, months: [], crossMonth: false } : evaluateBatch(next)
  const list = [...batches]
  list[index] = evaluated
  saveBatches(list)
  return { ok: true, batch: evaluated, message: `已移除该条，批次剩余 ${remaining.length} 条` }
}

export function discardBatch(batchId: number): { ok: boolean; message: string } {
  const batches = allBatches()
  const index = batches.findIndex((batch) => batch.id === batchId)
  if (index < 0) {
    return { ok: false, message: '批次不存在' }
  }
  if (batches[index].status !== '待确认') {
    return { ok: false, message: '只能作废待确认批次' }
  }
  const list = [...batches]
  list[index] = { ...list[index], status: '已作废' }
  saveBatches(list)
  return { ok: true, message: `批次 ${list[index].batchNo} 已作废` }
}

export interface ConfirmResult {
  ok: boolean
  message: string
  batch?: DutyBatch
}

/**
 * 确认批次：无阻塞冲突才允许。
 * 一次写入三张表——
 *  1) 值勤排班表（duty）：每条落一条，已确认；
 *  2) 扑火队伍待命表（fireteam）：整个批次落一条待命；
 *  3) 防火检查站换岗清单（checkpoint）：整个批次落一条换岗。
 */
export function confirmBatch(batchId: number): ConfirmResult {
  const batches = allBatches()
  const index = batches.findIndex((batch) => batch.id === batchId)
  if (index < 0) {
    return { ok: false, message: '批次不存在' }
  }
  const batch = evaluateBatch(batches[index])
  if (batch.status !== '待确认') {
    return { ok: false, message: `批次当前为「${batch.status}」，无需确认` }
  }
  if (batch.entries.length === 0) {
    return { ok: false, message: '批次已没有排班条目，无法确认' }
  }
  const blocked = batch.entries.filter((entry) =>
    entry.conflicts.some((conflict) => conflict.severity === 'block'),
  )
  if (blocked.length > 0) {
    return {
      ok: false,
      message: `仍有 ${blocked.length} 条阻塞冲突，请先逐条移除或处理`,
    }
  }

  // 1) 值勤排班表
  const dutyRows = listRows('duty')
  const dutyNos: string[] = []
  const addedDuty: EntryRow[] = batch.entries.map((entry, offset) => {
    const id = nextRowId(dutyRows) + offset
    const no = `DUTY-${String(id).padStart(4, '0')}`
    dutyNos.push(no)
    return {
      id,
      status: '已确认',
      pending: true,
      abnormal: false,
      排班编号: no,
      值勤日期: entry.date,
      值勤时段: entry.slot,
      值勤岗位: entry.post,
      值勤人员: entry.person,
      接班人员: '',
      交接记录: batch.crossMonth ? `批次${batch.batchNo}（跨月）待交接` : `批次${batch.batchNo}待交接`,
      排班状态: '已确认',
      批次编号: batch.batchNo,
    }
  })
  saveRows('duty', [...dutyRows, ...addedDuty])

  const rangeLabel = `${batch.months[0] ?? ''}${batch.crossMonth ? ' 至 ' + batch.months[batch.months.length - 1] : ''}`
  const postNames = [...new Set(batch.entries.map((entry) => entry.post))].join('、')
  const personNames = [...new Set(batch.entries.map((entry) => entry.person))].join('、')

  // 2) 扑火队伍待命表：确认后跟着落一条待命
  const teamRows = listRows('fireteam')
  const teamId = nextRowId(teamRows)
  const standbyNo = `FIRE-${String(teamId).padStart(4, '0')}`
  const standby: EntryRow = {
    id: teamId,
    status: '在营待命',
    pending: true,
    abnormal: false,
    队伍编号: standbyNo,
    队伍名称: `批次${batch.batchNo} 值勤待命`,
    所属林场: postNames,
    队长姓名: personNames,
    队员人数: String(batch.entries.length),
    集结半径: '按值勤岗位就近集结',
    值班状态: `待命（${rangeLabel}）`,
    出动状态: '未出动',
    批次编号: batch.batchNo,
  }
  saveRows('fireteam', [...teamRows, standby])

  // 3) 防火检查站换岗清单：确认后跟着落一条换岗
  const checkpointRows = listRows('checkpoint')
  const checkpointId = nextRowId(checkpointRows)
  const checkpointNo = `CHEC-${String(checkpointId).padStart(4, '0')}`
  const change: EntryRow = {
    id: checkpointId,
    status: '等待换岗',
    pending: true,
    abnormal: false,
    站点编号: checkpointNo,
    站点位置: postNames,
    值守人员: personNames,
    检查项目: `随批次${batch.batchNo}换岗`,
    通行车辆数: '0',
    收缴火种数: '0',
    值班日期: rangeLabel,
    运行状态: '等待换岗',
    批次编号: batch.batchNo,
  }
  saveRows('checkpoint', [...checkpointRows, change])

  const confirmed: DutyBatch = {
    ...batch,
    status: '已确认',
    confirmedAt: new Date().toISOString(),
    dutyNos,
    standbyNo,
    checkpointNo,
  }
  const list = [...allBatches()]
  list[list.findIndex((item) => item.id === batch.id)] = confirmed
  saveBatches(list)

  return {
    ok: true,
    batch: confirmed,
    message: `已确认 ${dutyNos.length} 条排班，并联动生成待命 ${standbyNo}、换岗 ${checkpointNo}`,
  }
}

/** 列出批次；加载时对待确认批次重新评估一次冲突（历史批次占位变化能反映出来）。 */
export function listBatches(): DutyBatch[] {
  const batches = allBatches()
  let changed = false
  const refreshed = batches.map((batch) => {
    if (batch.status !== '待确认') {
      return batch
    }
    const evaluated = evaluateBatch(batch)
    if (JSON.stringify(evaluated) !== JSON.stringify(batch)) {
      changed = true
    }
    return evaluated
  })
  if (changed) {
    saveBatches(refreshed)
  }
  return [...refreshed].sort((a, b) => b.id - a.id)
}

export function getBatch(batchNo: string): DutyBatch | undefined {
  return listBatches().find((batch) => batch.batchNo === batchNo)
}

export interface DutyStats {
  todayCount: number
  pendingHandover: number
  transferCount: number
  pendingBatches: number
}

export function dutyStats(today: string): DutyStats {
  const rows = listRows('duty')
  return {
    todayCount: rows.filter((row) => String(row['值勤日期']) === today).length,
    pendingHandover: rows.filter((row) =>
      ['已确认', '值勤中'].includes(String(row.status)),
    ).length,
    transferCount: rows.filter((row) => String(row.status) === '已调班').length,
    pendingBatches: allBatches().filter((batch) => batch.status === '待确认').length,
  }
}
