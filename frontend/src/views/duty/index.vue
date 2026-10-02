<template>
  <section class="page" data-module="duty">
    <header class="page-head">
      <div>
        <h2>值勤排班管理</h2>
        <p class="page-desc">维护值勤排班表，围绕排班编号、值勤日期、值勤时段、值勤岗位做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="showConsole = !showConsole">
          {{ showConsole ? '收起批量排班台' : '批量排班台' }}
        </button>
        <button class="btn" type="button" @click="openCreate">登记值勤排班表</button>
        <button class="btn" type="button" @click="exportRows">导出值勤排班清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section v-if="showConsole" class="batch-console">
      <h3>批量排班台</h3>
      <p class="hint-text">
        多选日期、值勤时段、岗位与人员，一次提交形成待确认批次；提交前按值勤日期和值勤时段检查人员重叠，
        跨月批次与交接记录冲突时按调班申请优先处理。
      </p>

      <div class="pick-group">
        <span>值勤日期（起止日期生成，可逐日勾选，单次最长 31 天）</span>
        <div class="pick-list">
          <label class="pick-item">起 <input v-model="dateStart" type="date" /></label>
          <label class="pick-item">止 <input v-model="dateEnd" type="date" /></label>
        </div>
        <div class="pick-list">
          <label v-for="day in dateOptions" :key="day" class="pick-item">
            <input v-model="pickedDates" type="checkbox" :value="day" /> {{ day }}
          </label>
          <span v-if="!dateOptions.length" class="hint-text">请先选择有效的起止日期</span>
        </div>
        <p v-if="rangeCrossMonth" class="hint-text">
          本批次跨月：与既有交接记录冲突时按调班申请优先，原班次将标记为已调班。
        </p>
      </div>

      <div class="pick-group">
        <span>值勤时段</span>
        <div class="pick-list">
          <label v-for="period in periods" :key="period" class="pick-item">
            <input v-model="pickedPeriods" type="checkbox" :value="period" /> {{ period }}
          </label>
        </div>
      </div>

      <div class="pick-group">
        <span>值勤岗位</span>
        <div class="pick-list">
          <label v-for="position in positions" :key="position" class="pick-item">
            <input v-model="pickedPositions" type="checkbox" :value="position" /> {{ position }}
          </label>
        </div>
      </div>

      <div class="pick-group">
        <span>值勤人员</span>
        <div class="pick-list">
          <label v-for="person in roster" :key="person" class="pick-item">
            <input v-model="pickedPersons" type="checkbox" :value="person" /> {{ person }}
          </label>
        </div>
      </div>

      <div class="pick-group">
        <span>接班人员（选填，应用到本批次全部条目）</span>
        <input v-model="reliever" placeholder="如：赵春梅" />
      </div>

      <div class="console-actions">
        <button class="btn" type="button" @click="buildPreview">生成预览</button>
        <button class="btn primary" type="button" :disabled="!preview.length" @click="submit">
          提交批次（待确认）
        </button>
        <span v-if="preview.length" class="hint-text">
          共 {{ preview.length }} 条，待写入 {{ includedCount }} 条，冲突 {{ previewConflictCount }} 条
        </span>
      </div>
      <p v-if="consoleMessage" class="notice-text">{{ consoleMessage }}</p>

      <table v-if="preview.length" class="data-table">
        <thead>
          <tr>
            <th>写入</th>
            <th>值勤日期</th>
            <th>值勤时段</th>
            <th>值勤岗位</th>
            <th>值勤人员</th>
            <th>冲突（逐条）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in preview" :key="entry.key">
            <td>
              <input type="checkbox" :checked="!entry.excluded" @change="toggleExclude(entry)" />
            </td>
            <td>{{ entry.值勤日期 }}</td>
            <td>{{ entry.值勤时段 }}</td>
            <td>{{ entry.值勤岗位 }}</td>
            <td>{{ entry.值勤人员 }}</td>
            <td>
              <template v-if="entry.conflicts.length">
                <span
                  v-for="(conflict, index) in entry.conflicts"
                  :key="index"
                  class="conflict-tag"
                  :class="{ overlap: conflict.kind === '人员重叠' }"
                >
                  {{ conflict.kind }}：{{ conflict.detail }}
                </span>
              </template>
              <span v-else class="ok-tag">无冲突</span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-if="batches.length" class="batch-console">
      <h3>排班批次</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>批次号</th>
            <th>提交时间</th>
            <th>条目数</th>
            <th>冲突条数</th>
            <th>跨月</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="batch in batches" :key="batch.id">
            <tr>
              <td>{{ batch.批次号 }}</td>
              <td>{{ batch.提交时间 }}</td>
              <td>{{ batch.entries.length }}</td>
              <td>{{ batchConflictCount(batch) }}</td>
              <td>{{ batch.跨月 ? '是' : '否' }}</td>
              <td>{{ batch.status }}</td>
              <td class="row-actions">
                <button class="link" type="button" @click="toggleDetail(batch.id)">
                  {{ expandedBatchId === batch.id ? '收起' : '逐条查看' }}
                </button>
                <button
                  v-if="batch.status === '待确认'"
                  class="link"
                  type="button"
                  @click="confirm(batch.id)"
                >
                  确认批次
                </button>
              </td>
            </tr>
            <tr v-if="expandedBatchId === batch.id" class="batch-detail-row">
              <td colspan="7">
                <table class="data-table">
                  <thead>
                    <tr>
                      <th>值勤日期</th>
                      <th>值勤时段</th>
                      <th>值勤岗位</th>
                      <th>值勤人员</th>
                      <th>接班人员</th>
                      <th>冲突明细</th>
                      <th>处理结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="entry in batch.entries" :key="entry.key">
                      <td>{{ entry.值勤日期 }}</td>
                      <td>{{ entry.值勤时段 }}</td>
                      <td>{{ entry.值勤岗位 }}</td>
                      <td>{{ entry.值勤人员 }}</td>
                      <td>{{ entry.接班人员 || '—' }}</td>
                      <td>
                        <template v-if="entry.conflicts.length">
                          <span
                            v-for="(conflict, index) in entry.conflicts"
                            :key="index"
                            class="conflict-tag"
                            :class="{ overlap: conflict.kind === '人员重叠' }"
                          >
                            {{ conflict.kind }}：{{ conflict.detail }}
                          </span>
                        </template>
                        <span v-else class="ok-tag">无冲突</span>
                      </td>
                      <td>{{ entry.resolution ?? (entry.excluded ? '已剔除，不写入' : '待确认') }}</td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </section>

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
          <td :colspan="columns.length + 2" class="empty-state">暂无值勤排班数据，可先登记值勤排班表</td>
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
import { computed, onMounted, ref, watch } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  DUTY_PERIODS,
  DUTY_POSITIONS,
  DUTY_ROSTER,
  buildBatchEntries,
  confirmBatch,
  datesBetween,
  listBatches,
  submitBatch,
} from '@/api/duty-batch-service'
import type { DutyBatch, DutyBatchEntry, EntryRow } from '@/data/types'

const meta = moduleMeta('duty')
const columns = ["排班编号", "值勤日期", "值勤时段", "值勤岗位", "值勤人员", "接班人员", "交接记录", "排班状态"]
const actions = ["确认排班", "记录交接", "申请调班"]
const statuses = ["待确认", "已确认", "值勤中", "已交接", "已调班"]
const stats = [{"label": "今日值勤人数", "value": 0}, {"label": "待交接次数", "value": 0}, {"label": "调班申请数", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 批量排班台
const periods = DUTY_PERIODS
const positions = DUTY_POSITIONS
const roster = DUTY_ROSTER

function todayString(): string {
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

function plusDays(base: string, days: number): string {
  const date = new Date(`${base}T00:00:00`)
  date.setDate(date.getDate() + days)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${mm}-${dd}`
}

const showConsole = ref(false)
const dateStart = ref(todayString())
const dateEnd = ref(plusDays(todayString(), 6))
const dateOptions = ref<string[]>([])
const pickedDates = ref<string[]>([])
const pickedPeriods = ref<string[]>([DUTY_PERIODS[0]])
const pickedPositions = ref<string[]>([])
const pickedPersons = ref<string[]>([])
const reliever = ref('')
const preview = ref<DutyBatchEntry[]>([])
const previewCrossMonth = ref(false)
const consoleMessage = ref('')
const batches = ref<DutyBatch[]>([])
const expandedBatchId = ref<number | null>(null)

const rangeCrossMonth = computed(
  () => new Set(pickedDates.value.map((day) => day.slice(0, 7))).size > 1,
)
const includedCount = computed(() => preview.value.filter((entry) => !entry.excluded).length)
const previewConflictCount = computed(
  () => preview.value.filter((entry) => entry.conflicts.length > 0).length,
)

watch([dateStart, dateEnd], ([start, end]) => {
  dateOptions.value = datesBetween(start, end)
  pickedDates.value = [...dateOptions.value]
  preview.value = []
}, { immediate: true })

function toggleExclude(entry: DutyBatchEntry) {
  entry.excluded = !entry.excluded
}

function buildPreview() {
  consoleMessage.value = ''
  if (
    !pickedDates.value.length
    || !pickedPeriods.value.length
    || !pickedPositions.value.length
    || !pickedPersons.value.length
  ) {
    preview.value = []
    consoleMessage.value = '日期、时段、岗位、人员至少各选一项才能生成预览'
    return
  }
  const { entries, crossMonth } = buildBatchEntries({
    dates: pickedDates.value,
    periods: pickedPeriods.value,
    positions: pickedPositions.value,
    persons: pickedPersons.value,
    接班人员: reliever.value.trim(),
  })
  preview.value = entries
  previewCrossMonth.value = crossMonth
}

function submit() {
  const result = submitBatch(preview.value, previewCrossMonth.value)
  consoleMessage.value = result.message
  if (!result.ok) {
    return
  }
  refreshBatches()
  if (result.batch) {
    expandedBatchId.value = result.batch.id
  }
  if (!result.duplicated) {
    preview.value = []
  }
}

function batchConflictCount(batch: DutyBatch): number {
  return batch.entries.filter((entry) => entry.conflicts.length > 0).length
}

function toggleDetail(id: number) {
  expandedBatchId.value = expandedBatchId.value === id ? null : id
}

function confirm(id: number) {
  errorMessage.value = ''
  const result = confirmBatch(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  consoleMessage.value = result.message
  refreshBatches()
  reload()
}

function refreshBatches() {
  batches.value = listBatches()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '值勤排班表登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
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
  refreshBatches()
})
</script>
