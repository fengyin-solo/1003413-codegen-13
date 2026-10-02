<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，支持多选日期、岗位、人员的批量排班台：一次提交形成待确认批次，逐条核对冲突，确认后联动待命与换岗。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="consoleOpen = !consoleOpen">
          {{ consoleOpen ? '收起批量排班台' : '打开批量排班台' }}
        </button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section v-if="consoleOpen" class="batch-console">
      <div class="console-head">
        <h3>批量排班台</h3>
        <span class="rule-hint">
          冲突规则：同一日期+时段人员重叠即阻塞；已生效调班优先于原始班次；已交接记录只提醒不阻塞。
        </span>
      </div>

      <p v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</p>
      <p v-if="errorMessage" class="error-text">{{ errorMessage }}</p>

      <div class="pick-area">
        <div class="pick-group">
          <span class="pick-label">值勤日期（多选，可跨月）</span>
          <div class="date-add">
            <input v-model="singleDate" type="date" :max="rangeEnd || undefined" />
            <button class="btn" type="button" @click="addSingleDate">添加单日</button>
            <input v-model="rangeStart" type="date" />
            <span class="date-sep">至</span>
            <input v-model="rangeEnd" type="date" />
            <button class="btn" type="button" @click="addDateRange">添加区间</button>
          </div>
          <div class="chip-row">
            <button
              v-for="date in selectedDates"
              :key="date"
              type="button"
              class="chip"
              @click="removeDate(date)"
            >
              {{ date }} ✕
            </button>
            <span v-if="!selectedDates.length" class="chip-empty">还没有选择日期</span>
          </div>
        </div>

        <div class="pick-group">
          <span class="pick-label">值勤时段（多选）</span>
          <div class="chip-row">
            <label v-for="slot in options.slots" :key="slot" class="pick-chip">
              <input v-model="selectedSlots" type="checkbox" :value="slot" />
              {{ slot }}
            </label>
          </div>
        </div>

        <div class="pick-group">
          <span class="pick-label">值勤岗位（多选）</span>
          <div class="chip-row">
            <label v-for="post in options.posts" :key="post" class="pick-chip">
              <input v-model="selectedPosts" type="checkbox" :value="post" />
              {{ post }}
            </label>
          </div>
        </div>

        <div class="pick-group">
          <span class="pick-label">值勤人员（多选）</span>
          <div class="chip-row">
            <label v-for="person in options.persons" :key="person" class="pick-chip">
              <input v-model="selectedPersons" type="checkbox" :value="person" />
              {{ person }}
            </label>
          </div>
        </div>
      </div>

      <div class="preview-bar">
        <span>
          将生成 <strong>{{ picked.length }}</strong> 条排班
          <em v-if="previewMonths.length > 1" class="cross-tag">跨月：{{ previewMonths.join('、') }}</em>
        </span>
        <button class="btn primary" type="button" :disabled="!picked.length" @click="submit">
          生成待确认批次
        </button>
      </div>

      <div class="batch-list">
        <h4>待确认 / 历史批次</h4>
        <table class="data-table">
          <thead>
            <tr>
              <th>批次编号</th>
              <th>提交时间</th>
              <th>覆盖月份</th>
              <th>条目</th>
              <th>冲突情况</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="batch in batches" :key="batch.id">
              <td>{{ batch.batchNo }}</td>
              <td>{{ formatTime(batch.createdAt) }}</td>
              <td>
                {{ batch.months.join('、') || '—' }}
                <em v-if="batch.crossMonth" class="cross-tag">跨月</em>
              </td>
              <td>{{ summaryOf(batch).total }}</td>
              <td>
                <span v-if="summaryOf(batch).blocked" class="badge block">
                  {{ summaryOf(batch).blocked }} 条阻塞
                </span>
                <span v-if="summaryOf(batch).warned" class="badge warn">
                  {{ summaryOf(batch).warned }} 条提醒
                </span>
                <span v-if="!hasConflict(batch)" class="badge ok">无冲突</span>
              </td>
              <td>{{ batch.status }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="toggleExpand(batch.id)">
                  {{ expandedIds.includes(batch.id) ? '收起' : '查看明细' }}
                </button>
                <button
                  v-if="batch.status === '待确认'"
                  class="link"
                  type="button"
                  :disabled="!summaryOf(batch).canConfirm"
                  :title="summaryOf(batch).canConfirm ? '' : '仍有阻塞冲突，需先逐条移除'"
                  @click="confirm(batch.id)"
                >
                  确认批次
                </button>
                <button
                  v-if="batch.status === '待确认'"
                  class="link danger"
                  type="button"
                  @click="discard(batch.id)"
                >
                  作废
                </button>
              </td>
            </tr>
            <tr v-if="!batches.length">
              <td colspan="7" class="empty-state">还没有批量排班批次，先在上方多选日期、岗位、人员生成一个</td>
            </tr>
          </tbody>
        </table>

        <div v-for="batch in batches" :key="`detail-${batch.id}`" v-show="expandedIds.includes(batch.id)" class="batch-detail">
          <div class="detail-head">
            <strong>{{ batch.batchNo }} 明细（{{ batch.entries.length }} 条）</strong>
            <span v-if="batch.status === '已确认'" class="linked-records">
              已联动：待命 {{ batch.standbyNo }} ｜ 换岗 {{ batch.checkpointNo }} ｜ 排班 {{ batch.dutyNos?.length ?? 0 }} 条
            </span>
          </div>
          <table class="data-table entry-table">
            <thead>
              <tr>
                <th>值勤日期</th>
                <th>值勤时段</th>
                <th>值勤岗位</th>
                <th>值勤人员</th>
                <th class="conflict-col">逐条冲突</th>
                <th v-if="batch.status === '待确认'">处理</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in batch.entries" :key="entry.localId">
                <td>{{ entry.date }}</td>
                <td>{{ entry.slot }}</td>
                <td>{{ entry.post }}</td>
                <td>{{ entry.person }}</td>
                <td class="conflict-col">
                  <ul v-if="entry.conflicts.length" class="conflict-list">
                    <li v-for="(conflict, ci) in entry.conflicts" :key="ci" :class="conflict.severity">
                      <span class="severity">{{ severityLabel(conflict.severity) }}</span>
                      {{ conflict.message }}
                    </li>
                  </ul>
                  <span v-else class="badge ok">无冲突</span>
                </td>
                <td v-if="batch.status === '待确认'">
                  <button class="link danger" type="button" @click="removeEntry(batch.id, entry.localId)">
                    移除该条
                  </button>
                </td>
              </tr>
              <tr v-if="!batch.entries.length">
                <td :colspan="batch.status === '待确认' ? 6 : 5" class="empty-state">批次已清空，可作废后重新提交</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先用批量排班台生成</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条值勤排班记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  confirmBatch,
  discardBatch,
  dutyOptions,
  dutyStats,
  listBatches,
  removeEntry as removeBatchEntry,
  submitBatch,
  summarize,
} from '@/api/duty-schedule'
import type { BatchSummary } from '@/api/duty-schedule'
import type { DutyBatch } from '@/data/duty-batch'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录", "批次编号", "排班状态"]
const actions = ["确认排班", "记录交接", "申请调班"]
const statuses = ["待确认", "已确认", "值勤中", "已交接", "已调班"]

const options = dutyOptions()

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// ---- 批量排班台状态 ----
const consoleOpen = ref(true)
const batches = ref<DutyBatch[]>([])
const expandedIds = ref<number[]>([])

const singleDate = ref(localToday())
const rangeStart = ref(localToday())
const rangeEnd = ref('')
const selectedDates = ref<string[]>([])
const selectedSlots = ref<string[]>([])
const selectedPosts = ref<string[]>([])
const selectedPersons = ref<string[]>([])

const statCards = computed(() => {
  const stats = dutyStats(localToday())
  return [
    { label: '今日值勤人数', value: stats.todayCount },
    { label: '待交接次数', value: stats.pendingHandover },
    { label: '调班申请数', value: stats.transferCount },
    { label: '待确认批次', value: stats.pendingBatches },
  ]
})

// 日期 × 时段 × 岗位 × 人员的笛卡尔积，即本次将提交的候选条目。
const picked = computed(() => {
  const result: Array<{ date: string; slot: string; post: string; person: string }> = []
  for (const date of selectedDates.value) {
    for (const slot of selectedSlots.value) {
      for (const post of selectedPosts.value) {
        for (const person of selectedPersons.value) {
          result.push({ date, slot, post, person })
        }
      }
    }
  }
  return result
})

const previewMonths = computed(() =>
  [...new Set(selectedDates.value.map((date) => date.slice(0, 7)))].sort(),
)

function localToday(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function formatDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

function enumerateDates(start: string, end: string): string[] {
  if (!start) {
    return []
  }
  if (!end || end < start) {
    return [start]
  }
  const result: string[] = []
  const cursor = new Date(`${start}T00:00:00`)
  const last = new Date(`${end}T00:00:00`)
  while (cursor <= last) {
    result.push(formatDate(cursor))
    cursor.setDate(cursor.getDate() + 1)
  }
  return result
}

function mergeDates(values: string[]) {
  selectedDates.value = [...new Set([...selectedDates.value, ...values])].sort()
}

function addSingleDate() {
  if (!singleDate.value) {
    errorMessage.value = '请先选择一个日期'
    return
  }
  errorMessage.value = ''
  mergeDates([singleDate.value])
}

function addDateRange() {
  if (!rangeStart.value || !rangeEnd.value) {
    errorMessage.value = '请选择区间的起止日期'
    return
  }
  if (rangeEnd.value < rangeStart.value) {
    errorMessage.value = '区间结束日期不能早于开始日期'
    return
  }
  errorMessage.value = ''
  mergeDates(enumerateDates(rangeStart.value, rangeEnd.value))
}

function removeDate(date: string) {
  selectedDates.value = selectedDates.value.filter((item) => item !== date)
}

function summaryOf(batch: DutyBatch): BatchSummary {
  return summarize(batch)
}

function hasConflict(batch: DutyBatch): boolean {
  return batch.entries.some((entry) => entry.conflicts.length > 0)
}

function severityLabel(severity: string): string {
  if (severity === 'block') {
    return '阻塞'
  }
  if (severity === 'warn') {
    return '提醒'
  }
  return '说明'
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) {
    return iso
  }
  return `${formatDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function toggleExpand(id: number) {
  if (expandedIds.value.includes(id)) {
    expandedIds.value = expandedIds.value.filter((item) => item !== id)
  } else {
    expandedIds.value = [...expandedIds.value, id]
  }
}

function reloadBatches() {
  batches.value = listBatches()
}

function submit() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = submitBatch(picked.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reloadBatches()
  if (result.batch) {
    if (!expandedIds.value.includes(result.batch.id)) {
      expandedIds.value = [...expandedIds.value, result.batch.id]
    }
    // 全新批次才清空选择；命中幂等去重时保留选择，方便操作者知道复用了哪份。
    if (!result.duplicated) {
      selectedDates.value = []
      selectedSlots.value = []
      selectedPosts.value = []
      selectedPersons.value = []
    }
  }
}

function removeEntry(batchId: number, localId: string) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = removeBatchEntry(batchId, localId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reloadBatches()
  reload()
}

function discard(batchId: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = discardBatch(batchId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reloadBatches()
}

function confirm(batchId: number) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = confirmBatch(batchId)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reloadBatches()
  reload()
}

// ---- 排班表列表（原有能力） ----
function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reloadBatches()
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '值勤排班列表读取失败'
  }
}

onMounted(() => {
  reload()
  reloadBatches()
})
</script>

<style scoped>
.batch-console {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-bottom: 14px;
}
.console-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
}
.console-head h3 {
  margin: 0 0 6px;
  font-size: 15px;
}
.rule-hint {
  font-size: 12px;
  color: var(--muted);
}
.notice-text {
  color: #1769aa;
  background: #eef6ff;
  border: 1px solid #cfe4fb;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12px;
  margin: 8px 0;
}
.pick-area {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 10px 0;
}
.pick-group {
  border: 1px dashed var(--border);
  border-radius: 6px;
  padding: 8px 10px;
}
.pick-label {
  display: block;
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 6px;
}
.date-add {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.date-add input[type='date'] {
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
}
.date-sep {
  color: var(--muted);
  font-size: 12px;
}
.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.chip {
  border: 1px solid var(--border);
  background: #f1f5fb;
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
}
.chip-empty {
  font-size: 12px;
  color: var(--muted);
}
.pick-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 12px;
  font-size: 12px;
  cursor: pointer;
  background: #fff;
}
.pick-chip:has(input:checked) {
  background: #e7f0fe;
  border-color: var(--brand);
  color: var(--brand);
}
.pick-chip input {
  margin: 0;
}
.preview-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-top: 1px solid var(--border);
  padding-top: 10px;
  font-size: 13px;
}
.cross-tag {
  font-style: normal;
  color: #b45309;
  background: #fef3c7;
  border-radius: 999px;
  padding: 1px 8px;
  margin-left: 8px;
  font-size: 12px;
}
.batch-list {
  margin-top: 14px;
}
.batch-list h4 {
  margin: 0 0 8px;
  font-size: 14px;
}
.badge {
  display: inline-block;
  border-radius: 999px;
  padding: 1px 9px;
  font-size: 12px;
  margin-right: 4px;
}
.badge.block {
  background: #fee2e2;
  color: #b42318;
}
.badge.warn {
  background: #fef3c7;
  color: #b45309;
}
.badge.ok {
  background: #dcfce7;
  color: #15803d;
}
.link:disabled {
  color: #aab4c2;
  cursor: not-allowed;
}
.link.danger {
  color: #b42318;
}
.batch-detail {
  border: 1px solid var(--border);
  border-top: none;
  padding: 10px;
  background: #fbfdff;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 8px;
  font-size: 13px;
}
.linked-records {
  font-size: 12px;
  color: #15803d;
}
.entry-table .conflict-col {
  min-width: 320px;
}
.conflict-list {
  margin: 0;
  padding-left: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.conflict-list li {
  font-size: 12px;
  border-radius: 4px;
  padding: 3px 8px;
}
.conflict-list .severity {
  display: inline-block;
  border-radius: 4px;
  padding: 0 6px;
  margin-right: 6px;
  font-size: 11px;
}
.conflict-list .block {
  background: #fef2f2;
  color: #b42318;
}
.conflict-list .block .severity {
  background: #b42318;
  color: #fff;
}
.conflict-list .warn {
  background: #fffbeb;
  color: #b45309;
}
.conflict-list .warn .severity {
  background: #d97706;
  color: #fff;
}
.conflict-list .info {
  background: #f0f7ff;
  color: #1769aa;
}
.conflict-list .info .severity {
  background: #1769aa;
  color: #fff;
}
</style>
