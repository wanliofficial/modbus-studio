<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState } from '../store'
import type { PacketLogItem } from '../../shared/types'

const store = useStore<RootState>()
const filterDirection = ref<'全部' | 'TX' | 'RX'>('全部')
const filterProtocol = ref<'全部' | 'RTU' | 'TCP'>('全部')
const filterAddressRange = ref<'全部' | 'coil' | 'discrete' | 'input' | 'holding'>('全部')
/** @brief 当前已渲染的条数，滚动接近底部时递增，实现动态加载更多历史。 */
const renderCount = ref(100)
const BATCH = 100

const addressRangeLabels: Record<string, string> = {
  coil: '线圈 0xxxx (00001-09999)',
  discrete: '离散输入 1xxxx (10001-19999)',
  input: '输入寄存器 3xxxx (30001-39999)',
  holding: '保持寄存器 4xxxx (40001-49999)'
}

/** @brief 从日志解析文本中推断所属 Modbus 数据区。 */
function getAreaFromParsed(parsed: string): string | null {
  const dispAddr = parsed.match(/地址\s*(\d{5})/)
  if (dispAddr) {
    const addr = Number(dispAddr[1])
    if (addr >= 40001 && addr <= 49999) return 'holding'
    if (addr >= 30001 && addr <= 39999) return 'input'
    if (addr >= 10001 && addr <= 19999) return 'discrete'
    if (addr >= 1 && addr <= 9999) return 'coil'
  }
  const fcMatch = parsed.match(/FC\s*(\d+)/i) || parsed.match(/功能码\s*(\d+)/)
  if (fcMatch) {
    const fc = Number(fcMatch[1])
    if (fc === 1 || fc === 5 || fc === 15) return 'coil'
    if (fc === 2) return 'discrete'
    if (fc === 4) return 'input'
    if (fc === 3 || fc === 6 || fc === 16) return 'holding'
  }
  if (/线圈|Coil/i.test(parsed)) return 'coil'
  if (/离散/.test(parsed)) return 'discrete'
  if (/输入寄存器/.test(parsed)) return 'input'
  if (/保持寄存器|Holding/i.test(parsed)) return 'holding'
  return null
}

const filteredLogs = computed(() => {
  return store.state.logs.filter((item: PacketLogItem) => {
    if (filterDirection.value !== '全部' && item.direction !== filterDirection.value) return false
    if (filterProtocol.value !== '全部' && item.protocol !== filterProtocol.value) return false
    if (filterAddressRange.value !== '全部') {
      if (getAreaFromParsed(item.parsed) !== filterAddressRange.value) return false
    }
    return true
  })
})

/**
 * @brief 当前实际渲染的日志切片。
 *
 * 日志按最新在前倒序排列；仅渲染前 renderCount 条，避免一次渲染上万行。
 */
const visibleLogs = computed(() => filteredLogs.value.slice(0, renderCount.value))
const hasMore = computed(() => renderCount.value < filteredLogs.value.length)

/**
 * @brief 表格滚动时按需加载更多历史日志。
 *
 * 日志最新在前，滚动条接近底部时说明用户想看更早的历史，遂追加一批渲染。
 * @param param0 el-table 滚动事件负载。
 */
function handleScroll({ scrollTop, scrollLeft }: { scrollTop: number; scrollLeft: number }): void {
  void scrollLeft
  const wrapper = document.querySelector('.log-table .el-table__body-wrapper') as HTMLElement | null
  if (!wrapper) return
  const distanceToBottom = wrapper.scrollHeight - wrapper.clientHeight - scrollTop
  if (distanceToBottom < 200 && hasMore.value) {
    renderCount.value += BATCH
  }
}

/** @brief 切换过滤条件或日志总量减少时，重置渲染计数。 */
watch([filterDirection, filterProtocol, filterAddressRange], () => {
  renderCount.value = 100
})
watch(() => filteredLogs.value.length, (length) => {
  if (length < renderCount.value) renderCount.value = Math.max(BATCH, length)
})

async function handleExport(): Promise<void> {
  if (!window.modbusApi) { ElMessage.warning('导出功能仅在桌面端可用'); return }
  if (store.state.logs.length === 0) { ElMessage.warning('日志为空，无数据可导出'); return }
  try {
    const path = await window.modbusApi.log.export(store.state.logs.map((item) => ({ ...item })))
    if (path) ElMessage.success('报文日志已导出')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <div class="page-stack">
    <section class="panel page-toolbar">
      <el-select v-model="filterDirection" style="width: 120px">
        <el-option label="全部方向" value="全部" />
        <el-option label="发送 TX" value="TX" />
        <el-option label="接收 RX" value="RX" />
      </el-select>
      <el-select v-model="filterProtocol" style="width: 130px; margin-left: 12px">
        <el-option label="全部协议" value="全部" />
        <el-option label="RTU" value="RTU" />
        <el-option label="TCP" value="TCP" />
      </el-select>
      <el-select v-model="filterAddressRange" style="width: 220px; margin-left: 12px">
        <el-option label="全部地址区" value="全部" />
        <el-option :label="addressRangeLabels.coil" value="coil" />
        <el-option :label="addressRangeLabels.discrete" value="discrete" />
        <el-option :label="addressRangeLabels.input" value="input" />
        <el-option :label="addressRangeLabels.holding" value="holding" />
      </el-select>
      <span class="toolbar-spacer" />
      <span class="toolbar-tip" style="margin-right: 16px">显示 {{ visibleLogs.length }} / {{ filteredLogs.length }} / {{ store.state.logs.length }} 条（最新在前，向下滚动加载更多）</span>
      <el-button @click="handleExport">导出日志</el-button>
      <el-button @click="store.commit('clearLogs')">清空日志</el-button>
    </section>
    <section class="panel page-table">
      <div class="panel-title">
        <h3>报文日志</h3>
        <span>{{ hasMore ? '向下滚动加载更早报文' : '已加载全部' }}</span>
      </div>
      <el-table :data="visibleLogs" height="100%" stripe class="log-table" empty-text="暂无通信报文" @scroll="handleScroll">
        <el-table-column prop="id" label="#" width="60" />
        <el-table-column prop="time" label="时间" width="110" />
        <el-table-column prop="direction" label="方向" width="80">
          <template #default="scope">
            <b :class="scope.row.direction.toLowerCase()">{{ scope.row.direction }}</b>
          </template>
        </el-table-column>
        <el-table-column prop="protocol" label="协议" width="80" />
        <el-table-column prop="raw" label="数据" min-width="300" show-overflow-tooltip />
        <el-table-column prop="parsed" label="解析结果" min-width="320" show-overflow-tooltip />
        <el-table-column prop="elapsedMs" label="耗时(ms)" width="90" />
        <el-table-column prop="status" label="状态" width="80" />
      </el-table>
    </section>
  </div>
</template>
