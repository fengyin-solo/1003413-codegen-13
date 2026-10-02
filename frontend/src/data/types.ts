/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 批量排班台：一次提交形成待确认批次，逐条记录冲突与处理结果。 */
export type DutyConflictKind = '人员重叠' | '跨月交接冲突'

export type DutyConflict = {
  kind: DutyConflictKind
  detail: string
  /** 冲突涉及的既有排班记录 id，确认批次时按优先级规则处理 */
  withEntryId?: number
}

export type DutyBatchEntry = {
  /** 值勤日期|值勤时段|值勤岗位|值勤人员，批次指纹的基本单元 */
  key: string
  值勤日期: string
  值勤时段: string
  值勤岗位: string
  值勤人员: string
  接班人员: string
  conflicts: DutyConflict[]
  /** 提交前被剔除的条目不写入排班表 */
  excluded: boolean
  /** 确认批次后回填的处理结果说明 */
  resolution?: string
}

export type DutyBatch = {
  id: number
  批次号: string
  /** 同一选择的指纹，重复提交只保留一份 */
  fingerprint: string
  提交时间: string
  跨月: boolean
  status: '待确认' | '已确认'
  entries: DutyBatchEntry[]
  联动扑火队伍id?: number
  联动检查站id?: number
}

export type BatchSubmitResult = {
  ok: boolean
  duplicated: boolean
  message: string
  batch?: DutyBatch
}
