<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useStore } from 'vuex'
import { ElMessage } from 'element-plus'
import type { RootState, ServerRuntimeInstance } from '../store'
import type { RegisterDefinition, ServerAreaName } from '../../shared/types'
import { decodeRegisterValue, encodeRegisterValue, formatRegisterHex, resolveRegisterAddress } from '../utils/register-data'

type EditableField = 'hex' | 'parsed'

const store = useStore<RootState>()
const activeArea = ref<ServerAreaName>('holding')
const selectedId = ref<string | null>(null)
const editValues = reactive<Record<string, string>>({})
const draftVisible = ref(false)
const draft = reactive({ name: '', slaveId: 1, tcpHost: '0.0.0.0', tcpPort: 502, protocol: 'TCP' as 'RTU' | 'TCP' })

const selected = computed<ServerRuntimeInstance | null>(() => {
  if (selectedId.value) return store.state.servers.find((item) => item.id === selectedId.value) ?? null
  return store.state.servers[0] ?? null
})

const activeRows = computed(() => {
  const instance = selected.value
  if (!instance) return []
  return store.state.dictionary.flatMap((item) => {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo || addressInfo.area !== activeArea.value) return []
    const values = getServerValues(instance, item)
    return [{ item, addressInfo, values, hex: formatRegisterHex(values), parsed: decodeRegisterValue(item, values) }]
  })
})
const isBitArea = computed(() => activeArea.value === 'coil' || activeArea.value === 'discrete')

/**
 * @brief 获取某从站实例字典项当前原始值。
 *
 * 优先返回已保存值，首次使用时按字典长度生成零值数组。
 */
function getServerValues(instance: ServerRuntimeInstance, item: RegisterDefinition): number[] {
  const stored = instance.dictionaryRegisters[String(item.address)]
  if (stored) return Array.from({ length: Math.max(1, item.length) }, (_, index) => stored[index] ?? 0)
  return Array.from({ length: Math.max(1, item.length) }, () => 0)
}

/**
 * @brief 获取 Server 单元格当前显示文本。
 */
function getCellValue(row: typeof activeRows.value[number], field: EditableField): string {
  return editValues[`${row.item.address}:${field}`] ?? row[field]
}

/**
 * @brief 更新 Server 单元格编辑缓存。
 */
function updateCellValue(item: RegisterDefinition, field: EditableField, value: string): void {
  editValues[`${item.address}:${field}`] = value
}

/**
 * @brief 将十六进制文本编码为原始值。
 */
function encodeHex(item: RegisterDefinition, text: string): number[] {
  const compact = text.replace(/0x/gi, '').replace(/[^0-9a-f]/gi, '')
  if (!compact || compact.length % 4 !== 0) throw new Error('HEX 值应按每个寄存器四位十六进制输入')
  const values = compact.match(/.{4}/g)?.map((value) => Number.parseInt(value, 16)) ?? []
  if (values.length !== Math.max(1, item.length)) throw new Error(`需要输入 ${Math.max(1, item.length)} 个原始值`)
  return values
}

/**
 * @brief 提交 Server 字典项编辑值。
 *
 * 保存到对应从站实例，并在服务运行时同步到主进程数据区。
 */
async function commitCell(item: RegisterDefinition, field: EditableField): Promise<void> {
  const instance = selected.value
  if (!instance) return
  const key = `${item.address}:${field}`
  if (!(key in editValues)) return
  try {
    const addressInfo = resolveRegisterAddress(item.address)
    if (!addressInfo) throw new Error('字典地址不属于有效 Modbus 数据区')
    const values = field === 'hex' ? encodeHex(item, editValues[key]) : encodeRegisterValue(item, editValues[key])
    if (values.length !== Math.max(1, item.length)) throw new Error(`数据类型需要 ${values.length} 个值，但字典长度配置为 ${item.length}`)
    store.commit('setServerInstanceDictionaryRegisters', { id: instance.id, key: String(item.address), values })
    if (instance.running) {
      await Promise.all(values.map((value, index) => window.modbusApi.server.updateInstanceData(instance.id, { area: addressInfo.area, address: addressInfo.protocolAddress + index, value })))
    }
    delete editValues[key]
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 更新位数据区的开关值。
 */
async function updateBitValue(item: RegisterDefinition, value: string | number | boolean): Promise<void> {
  const instance = selected.value
  if (!instance) return
  const addressInfo = resolveRegisterAddress(item.address)
  if (!addressInfo) return
  const values = [value ? 1 : 0]
  store.commit('setServerInstanceDictionaryRegisters', { id: instance.id, key: String(item.address), values })
  if (instance.running) await window.modbusApi.server.updateInstanceData(instance.id, { area: addressInfo.area, address: addressInfo.protocolAddress, value: values[0] })
}

/**
 * @brief 打开新增从站对话框。
 */
function openCreateDialog(): void {
  Object.assign(draft, { name: `从站 ${store.state.servers.length + 1}`, slaveId: store.state.server.slaveId, tcpHost: store.state.server.tcpHost, tcpPort: store.state.server.tcpPort + store.state.servers.length, protocol: store.state.server.protocol })
  draftVisible.value = true
}

/**
 * @brief 保存新增从站。
 */
function saveInstance(): void {
  if (!draft.name.trim()) { ElMessage.warning('请输入从站名称'); return }
  const id = 'srv-' + Date.now()
  store.commit('addServerInstance', {
    id,
    name: draft.name.trim(),
    slaveId: draft.slaveId,
    tcpHost: draft.tcpHost,
    tcpPort: draft.tcpPort,
    protocol: draft.protocol,
    running: false,
    requestCount: 0,
    dictionaryRegisters: {}
  })
  selectedId.value = id
  draftVisible.value = false
  ElMessage.success('从站已添加')
}

/**
 * @brief 切换指定从站启停状态。
 */
async function toggleInstance(id: string): Promise<void> {
  try {
    await store.dispatch('toggleServerInstance', id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

/**
 * @brief 删除指定从站。
 */
async function removeInstance(id: string): Promise<void> {
  try {
    await store.dispatch('removeServerInstance', id)
    if (selectedId.value === id) selectedId.value = null
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <div class="workspace server-workspace">
    <aside class="side-column">
      <section class="panel server-list-panel">
        <div class="panel-title"><h3>从站列表</h3><el-button size="small" type="primary" @click="openCreateDialog">新增从站</el-button></div>
        <div v-if="store.state.servers.length === 0" class="empty-tip">暂无从站，点击「新增从站」创建</div>
        <div
          v-for="instance in store.state.servers"
          :key="instance.id"
          class="server-item"
          :class="{ active: selected?.id === instance.id }"
          @click="selectedId = instance.id"
        >
          <div class="server-item-main">
            <strong>{{ instance.name }}</strong>
            <small>从站 {{ instance.slaveId }} · {{ instance.protocol }} · {{ instance.tcpHost }}:{{ instance.tcpPort }}</small>
            <div class="server-item-stat">
              <i :class="{ online: instance.running }" />{{ instance.running ? '运行中' : '已停止' }}
              <span>请求 {{ instance.requestCount }}</span>
            </div>
          </div>
          <div class="server-item-actions" @click.stop>
            <el-button size="small" :type="instance.running ? 'danger' : 'success'" @click="toggleInstance(instance.id)">{{ instance.running ? '停止' : '启动' }}</el-button>
            <el-button size="small" link type="danger" @click="removeInstance(instance.id)">删除</el-button>
          </div>
        </div>
      </section>
    </aside>
    <section class="content-column">
      <section class="panel register-panel full-height">
        <div v-if="!selected" class="empty-tip full-empty">请选择或创建一个从站</div>
        <template v-else>
          <div class="panel-title"><h3>{{ selected.name }} - 数据区</h3><span>从站地址 {{ selected.slaveId }} · {{ selected.running ? '运行中' : '已停止' }}</span></div>
          <el-tabs v-model="activeArea">
            <el-tab-pane label="线圈 (0xxxx)" name="coil" /><el-tab-pane label="离散输入 (1xxxx)" name="discrete" /><el-tab-pane label="输入寄存器 (3xxxx)" name="input" /><el-tab-pane label="保持寄存器 (4xxxx)" name="holding" />
          </el-tabs>
          <el-table :data="activeRows" height="calc(100% - 95px)" stripe empty-text="寄存器字典中没有该数据区的地址">
            <el-table-column label="地址" width="100"><template #default="scope">{{ scope.row.item.address }}</template></el-table-column>
            <el-table-column label="名称" min-width="150"><template #default="scope"><strong>{{ scope.row.item.name }}</strong><small class="cell-meta">{{ scope.row.item.dataType }} / 长度 {{ scope.row.item.length }}</small></template></el-table-column>
            <el-table-column v-if="isBitArea" label="当前状态" min-width="150"><template #default="scope"><el-switch :model-value="Boolean(scope.row.values[0])" @change="updateBitValue(scope.row.item, $event)" /></template></el-table-column>
            <el-table-column v-if="!isBitArea" label="原始值 HEX" min-width="190"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'hex')" size="small" @update:model-value="updateCellValue(scope.row.item, 'hex', $event)" @change="commitCell(scope.row.item, 'hex')" /></template></el-table-column>
            <el-table-column v-if="!isBitArea" label="解析值" min-width="170"><template #default="scope"><el-input :model-value="getCellValue(scope.row, 'parsed')" size="small" @update:model-value="updateCellValue(scope.row.item, 'parsed', $event)" @change="commitCell(scope.row.item, 'parsed')" /></template></el-table-column>
            <el-table-column label="倍率/单位" min-width="125"><template #default="scope">×{{ scope.row.item.factor }} {{ scope.row.item.unit }}</template></el-table-column>
            <el-table-column label="权限" width="80"><template #default="scope"><el-tag :type="scope.row.item.access === 'R' ? 'info' : 'success'">{{ scope.row.item.access }}</el-tag></template></el-table-column>
            <el-table-column label="备注" min-width="180"><template #default="scope">{{ scope.row.item.remark }}</template></el-table-column>
          </el-table>
        </template>
      </section>
    </section>

    <el-dialog v-model="draftVisible" title="新增从站" width="460px">
      <el-form label-width="90px">
        <el-form-item label="名称"><el-input v-model="draft.name" /></el-form-item>
        <el-form-item label="协议"><el-select v-model="draft.protocol"><el-option label="Modbus TCP" value="TCP" /><el-option label="Modbus RTU" value="RTU" /></el-select></el-form-item>
        <el-form-item label="从站地址"><el-input-number v-model="draft.slaveId" :min="1" :max="247" controls-position="right" /></el-form-item>
        <el-form-item label="监听地址"><el-input v-model="draft.tcpHost" /></el-form-item>
        <el-form-item label="监听端口"><el-input-number v-model="draft.tcpPort" :min="1" :max="65535" controls-position="right" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="draftVisible = false">取消</el-button><el-button type="primary" @click="saveInstance">保存</el-button></template>
    </el-dialog>
  </div>
</template>
