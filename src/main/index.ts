import { app, BrowserWindow, Menu, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import * as iconv from 'iconv-lite'
import type { PacketLogItem, ProjectData, ReadRegistersParams, RecentProject, RegisterDefinition, SerialConfig, ServerConfig, ServerDataUpdate, ServerEvent, ServerInstanceConfig, TcpConfig, WriteMultipleRegistersParams, WriteRegisterParams } from '../shared/types'

/**
 * @brief 解析显示地址字符串为内部数值。
 *
 * 格式：首位 1-4（区号）+ 四位 hex 协议地址。兼容 0x 前缀和纯十进制。
 * @param text 地址文本。
 * @returns 内部数值地址，无效时返回 0x40000。
 */
function parseAddress(text: string): number {
  const trimmed = text.trim()
  if (/^[1-4][0-9a-fA-F]{4}$/.test(trimmed)) {
    const area = Number(trimmed[0])
    const protocol = Number.parseInt(trimmed.slice(1), 16)
    if (!Number.isNaN(protocol)) return area * 0x10000 + protocol
  }
  if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) return Number.parseInt(trimmed.slice(2), 16) || 0x40000
  return Number(trimmed) || 0x40000
}
import { SerialService } from './services/SerialService'
import { ModbusClientService } from './services/ModbusClientService'
import { TcpClientService } from './services/TcpClientService'
import { UdpClientService } from './services/UdpClientService'
import { ModbusServerService } from './services/ModbusServerService'

const serialService = new SerialService()
const clientService = new ModbusClientService(serialService)
const tcpClientService = new TcpClientService()
const udpClientService = new UdpClientService()
const serverService = new ModbusServerService()

/**
 * @brief 按协议分发客户端事务到 TCP/UDP/RTU 服务。
 *
 * 集中处理协议路由，避免每个 IPC handler 重复三元判断。
 * @param params 含 protocol 字段的事务参数。
 * @param tcp TCP 分支。
 * @param udp UDP 分支。
 * @param rtu RTU 分支。
 * @returns 对应协议事务的结果。
 */
function dispatchClient<T>(params: { protocol?: string }, tcp: () => Promise<T>, udp: () => Promise<T>, rtu: () => Promise<T>): Promise<T> {
  if (params.protocol === 'TCP') return tcp()
  if (params.protocol === 'UDP') return udp()
  return rtu()
}
/**
 * @brief 返回最近工程记录文件路径。
 *
 * 将最近工程元数据保存在 Electron 用户数据目录，避免污染项目源码目录。
 * @returns 最近工程记录文件的绝对路径。
 */
function getRecentProjectsPath(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

/**
 * @brief 读取最近工程列表。
 *
 * 文件不存在或内容损坏时返回空数组，最多保留最近十个工程。
 * @returns 最近工程列表。
 */
async function readRecentProjects(): Promise<RecentProject[]> {
  try {
    const content = await readFile(getRecentProjectsPath(), 'utf8')
    return (JSON.parse(content) as RecentProject[]).slice(0, 10)
  } catch {
    return []
  }
}

/**
 * @brief 将工程加入最近工程列表。
 *
 * 根据路径去重并把最新工程放在首位，然后持久化到用户数据目录。
 * @param path 工程文件路径。
 * @param name 工程名称。
 * @returns 更新后的最近工程列表。
 */
async function addRecentProject(path: string, name: string): Promise<RecentProject[]> {
  const current = await readRecentProjects()
  const projects = [{ path, name, openedAt: new Date().toISOString() }, ...current.filter((item) => item.path !== path)].slice(0, 10)
  await writeFile(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf8')
  return projects
}

/**
 * @brief 解码 CSV 文件缓冲区。
 *
 * 先尝试 UTF-8 解码；若结果包含替换字符（U+FFFD，说明不是合法 UTF-8），
 * 则按 GBK 解码兜底，兼容 WPS/Excel 默认以 GBK/ANSI 保存的 CSV。
 * @param buffer 文件原始字节。
 * @returns 解码后的文本。
 */
function decodeCsvBuffer(buffer: Buffer): string {
  const utf8 = iconv.decode(buffer, 'utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  return iconv.decode(buffer, 'gbk')
}

/**
 * @brief 从指定路径读取工程。
 *
 * 解析 MBS 或 JSON 文件，并在读取成功后更新最近工程列表。
 * @param path 工程文件路径。
 * @returns 工程路径和数据。
 */
async function openProjectFile(path: string): Promise<{ path: string; data: ProjectData }> {
  const data = JSON.parse(await readFile(path, 'utf8')) as ProjectData
  await addRecentProject(path, data.name)
  return { path, data }
}

/**
 * @brief 创建 Modbus Studio 主窗口。
 *
 * 开发环境加载 Vite 服务，生产环境加载打包后的静态页面，并启用上下文隔离。
 */
function createWindow(): void {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f3f6fb',
    title: 'Modbus Studio',
    icon: join(__dirname, '../../public/icon.ico'),
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.setMenuBarVisibility(false)
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) void window.loadURL(devUrl)
  else void window.loadFile(join(__dirname, '../../dist/index.html'))
}

/**
 * @brief 注册渲染进程可调用的 IPC 接口。
 *
 * 集中注册串口、Modbus Client 和工程文件接口，避免渲染进程直接获得 Node.js 权限。
 */
function registerIpcHandlers(): void {
  ipcMain.handle('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
  ipcMain.handle('window:toggle-maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })
  ipcMain.handle('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
  ipcMain.handle('serial:list', () => serialService.listPorts())
  ipcMain.handle('serial:open', (_event, config: SerialConfig) => serialService.open(config))
  ipcMain.handle('serial:close', () => serialService.close())
  ipcMain.handle('tcp:connect', (_event, config: TcpConfig) => tcpClientService.connect(config))
  ipcMain.handle('tcp:disconnect', () => tcpClientService.disconnect())
  ipcMain.handle('udp:connect', (_event, config: TcpConfig) => udpClientService.connect(config))
  ipcMain.handle('udp:disconnect', () => udpClientService.disconnect())
  ipcMain.handle('client:read-registers', (_event, params: ReadRegistersParams) => dispatchClient(params, () => tcpClientService.readRegisters(params), () => udpClientService.readRegisters(params), () => clientService.readRegisters(params)))
  ipcMain.handle('client:write-single', (_event, params: WriteRegisterParams) => dispatchClient(params, () => tcpClientService.writeSingleRegister(params), () => udpClientService.writeSingleRegister(params), () => clientService.writeSingleRegister(params)))
  ipcMain.handle('client:write-multiple', (_event, params: WriteMultipleRegistersParams) => dispatchClient(params, () => tcpClientService.writeMultipleRegisters(params), () => udpClientService.writeMultipleRegisters(params), () => clientService.writeMultipleRegisters(params)))
  ipcMain.handle('server:start-instance', (_event, instance: ServerInstanceConfig, data: ServerDataUpdate[]) => serverService.startInstance(instance, data))
  ipcMain.handle('server:stop-instance', (_event, id: string) => serverService.stopInstance(id))
  ipcMain.handle('server:update-instance-data', (_event, id: string, update: ServerDataUpdate) => serverService.updateInstanceData(id, update))
  ipcMain.handle('project:open', async () => {
    const selected = await dialog.showOpenDialog({
      title: '打开 Modbus Studio 工程',
      filters: [{ name: 'Modbus Studio 工程', extensions: ['mbs', 'json'] }],
      properties: ['openFile']
    })
    if (selected.canceled || selected.filePaths.length === 0) return null
    const path = selected.filePaths[0]
    return openProjectFile(path)
  })
  ipcMain.handle('project:open-path', (_event, path: string) => openProjectFile(path))
  ipcMain.handle('project:save', async (_event, data: ProjectData, currentPath?: string, saveAs = false) => {
    let path = saveAs ? undefined : currentPath
    if (!path) {
      const selected = await dialog.showSaveDialog({
        title: '保存 Modbus Studio 工程',
        defaultPath: `${data.name || '未命名工程'}.mbs`,
        filters: [{ name: 'Modbus Studio 工程', extensions: ['mbs'] }]
      })
      if (selected.canceled || !selected.filePath) return null
      path = selected.filePath
    }
    await writeFile(path, JSON.stringify(data, null, 2), 'utf8')
    await addRecentProject(path, data.name)
    return path
  })
  ipcMain.handle('project:list-recent', () => readRecentProjects())
  ipcMain.handle('project:remove-recent', async (_event, path: string) => {
    const projects = (await readRecentProjects()).filter((item) => item.path !== path)
    await writeFile(getRecentProjectsPath(), JSON.stringify(projects, null, 2), 'utf8')
    return projects
  })
  ipcMain.handle('dictionary:export', async (_event, items: RegisterDefinition[]) => {
    const selected = await dialog.showSaveDialog({
      title: '导出寄存器字典',
      defaultPath: 'register-dictionary.csv',
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: 'JSON 文件', extensions: ['json'] }
      ]
    })
    if (selected.canceled || !selected.filePath) return null
    const isCsv = selected.filePath.endsWith('.csv')
    const content = isCsv
      ? '﻿分组,地址,名称,数据类型,长度,从站,读写,比例因子,单位,备注\n' + items.map((item) => {
          const area = Math.floor(item.address / 0x10000)
          const protocol = item.address & 0xffff
          const display = `${area}${protocol.toString(16).toUpperCase().padStart(4, '0')}`
          return `"${item.group}","${display}","${item.name}","${item.dataType}","${item.length}","${item.slaveId ?? 0}","${item.access}","${item.factor}","${item.unit}","${item.remark}"`
        }).join('\n')
      : JSON.stringify(items.map((item) => {
          const area = Math.floor(item.address / 0x10000)
          const protocol = item.address & 0xffff
          return { ...item, address: `${area}${protocol.toString(16).toUpperCase().padStart(4, '0')}` }
        }), null, 2)
    await writeFile(selected.filePath, content, 'utf8')
    return selected.filePath
  })
  ipcMain.handle('dictionary:import', async () => {
    const selected = await dialog.showOpenDialog({
      title: '导入寄存器字典',
      filters: [
        { name: '字典文件', extensions: ['csv', 'json'] },
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: 'JSON 文件', extensions: ['json'] }
      ],
      properties: ['openFile']
    })
    if (selected.canceled || selected.filePaths.length === 0) return null
    const filePath = selected.filePaths[0]
    if (filePath.endsWith('.csv')) {
      const buffer = await readFile(filePath)
      let text = decodeCsvBuffer(buffer)
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1) // 去掉 UTF-8 BOM
      const lines = text.split('\n').filter((line) => line.trim())
      if (lines.length < 2) return []
      const hasSlaveColumn = lines[0].includes('从站')
      return lines.slice(1).map((line) => {
        const parts = line.match(/(".*?"|[^",\s]+)(?=\s*,|\s*$)/g) ?? line.split(',')
        const val = (index: number): string => (parts[index] ?? '').replace(/^"|"$/g, '').trim()
        const offset = hasSlaveColumn ? 1 : 0
        const slaveRaw = hasSlaveColumn ? Number(val(5)) : 0
        return {
          group: val(0) || '默认分组',
          address: parseAddress(val(1)),
          name: val(2) || '',
          dataType: val(3) || 'UINT16',
          length: Number(val(4)) || 1,
          slaveId: slaveRaw > 0 ? slaveRaw : undefined,
          access: (val(5 + offset) as 'R' | 'W' | 'RW') || 'R',
          factor: Number(val(6 + offset)) || 1,
          unit: val(7 + offset) || '无',
          remark: val(8 + offset) || ''
        } as RegisterDefinition
      })
    }
    const content = await readFile(filePath, 'utf8')
    const raw = JSON.parse(content) as RegisterDefinition[]
    return raw.map((item) => ({ ...item, address: typeof item.address === 'string' ? parseAddress(item.address) : item.address }))
  })
  ipcMain.handle('log:export', async (_event, items: PacketLogItem[]) => {
    const selected = await dialog.showSaveDialog({
      title: '导出报文日志',
      defaultPath: 'modbus-log.csv',
      filters: [
        { name: 'CSV 文件', extensions: ['csv'] },
        { name: '文本文件', extensions: ['txt'] }
      ]
    })
    if (selected.canceled || !selected.filePath) return null
    const isCsv = selected.filePath.endsWith('.csv')
    const content = isCsv
      ? '﻿序号,时间,方向,协议,原始数据,解析结果,耗时(ms),状态\n' + items.map((item) => `"${item.id}","${item.time}","${item.direction}","${item.protocol}","${item.raw}","${item.parsed}","${item.elapsedMs}","${item.status}"`).join('\n')
      : items.map((item) => `[${item.time}] ${item.direction} ${item.protocol} ${item.raw} | ${item.parsed} | ${item.elapsedMs}ms | ${item.status}`).join('\n')
    await writeFile(selected.filePath, content, 'utf8')
    return selected.filePath
  })
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  registerIpcHandlers()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())
})

serverService.on('server-event', (event: ServerEvent) => {
  BrowserWindow.getAllWindows().forEach((window) => window.webContents.send('server:event', event))
})

app.on('window-all-closed', () => {
  void serialService.close()
  void tcpClientService.disconnect()
  void udpClientService.disconnect()
  void serverService.stopAll()
  if (process.platform !== 'darwin') app.quit()
})
