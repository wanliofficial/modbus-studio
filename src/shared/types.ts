export type Parity = 'none' | 'even' | 'odd'
export type ProtocolMode = 'RTU' | 'TCP' | 'UDP'

export interface SerialConfig {
  path: string
  baudRate: number
  dataBits: 5 | 6 | 7 | 8
  stopBits: 1 | 2
  parity: Parity
  timeout: number
}

export interface TcpConfig {
  host: string
  port: number
  timeout: number
}

export interface ReadRegistersParams {
  protocol?: ProtocolMode
  slaveId: number
  functionCode: 1 | 2 | 3 | 4
  startAddress: number
  quantity: number
  timeout: number
}

export interface WriteRegisterParams {
  protocol?: ProtocolMode
  slaveId: number
  functionCode?: 5 | 6
  address: number
  value: number
  timeout: number
}

export interface WriteMultipleRegistersParams {
  protocol?: ProtocolMode
  slaveId: number
  functionCode?: 15 | 16
  startAddress: number
  values: number[]
  timeout: number
}

export interface TransactionResult {
  tx: string
  rx: string
  registers: number[]
  elapsedMs: number
  crcValid: boolean
}

export type ServerAreaName = 'coil' | 'discrete' | 'input' | 'holding'

export interface ServerConfig {
  protocol: ProtocolMode
  slaveId: number
  serial: SerialConfig
  tcp: { host: string; port: number }
}

export interface ServerInstanceConfig {
  id: string
  name: string
  slaveId: number
  tcpHost: string
  tcpPort: number
  protocol: ProtocolMode
  points?: RegisterDefinition[]
  serial?: SerialConfig
}

export interface ServerDataUpdate {
  area: ServerAreaName
  address: number
  value: number
}

export interface ServerEvent {
  type: 'status' | 'data' | 'log'
  instanceId?: string
  running?: boolean
  protocol?: ProtocolMode
  update?: ServerDataUpdate
  log?: Omit<PacketLogItem, 'id'>
}

export interface PacketLogItem {
  id: number
  time: string
  direction: 'TX' | 'RX'
  protocol: ProtocolMode
  raw: string
  parsed: string
  elapsedMs: number
  status: '成功' | '失败' | '发送'
}

export interface ProjectData {
  name: string
  description: string
  version: string
  connection: SerialConfig
  protocol?: ProtocolMode
  tcp?: TcpConfig
  server?: {
    protocol: ProtocolMode
    slaveId: number
    tcpHost: string
    tcpPort: number
  }
  servers?: ServerInstanceConfig[]
  client: ReadRegistersParams & { pollInterval: number; mergeRead?: boolean }
  registerDictionary: RegisterDefinition[]
  clientData?: {
    dictionaryRegisters: Record<string, number[]>
    lastElapsedMs: number
  }
  serverData?: {
    dictionaryRegisters: Record<string, number[]>
    requestCount: number
  }
  packetLogs?: PacketLogItem[]
  counters?: { tx: number; rx: number; error: number }
}

export interface RecentProject {
  path: string
  name: string
  openedAt: string
}

export interface RegisterDefinition {
  group: string
  address: number
  name: string
  dataType: string
  length: number
  access: 'R' | 'W' | 'RW'
  factor: number
  unit: string
  remark: string
  slaveId?: number
}

export interface ModbusApi {
  window: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
  }
  serial: {
    listPorts: () => Promise<string[]>
    open: (config: SerialConfig) => Promise<void>
    close: () => Promise<void>
  }
  tcp: {
    connect: (config: TcpConfig) => Promise<void>
    disconnect: () => Promise<void>
  }
  udp: {
    connect: (config: TcpConfig) => Promise<void>
    disconnect: () => Promise<void>
  }
  client: {
    readRegisters: (params: ReadRegistersParams) => Promise<TransactionResult>
    writeSingleRegister: (params: WriteRegisterParams) => Promise<TransactionResult>
    writeMultipleRegisters: (params: WriteMultipleRegistersParams) => Promise<TransactionResult>
  }
  server: {
    startInstance: (instance: ServerInstanceConfig, data: ServerDataUpdate[]) => Promise<void>
    stopInstance: (id: string) => Promise<void>
    updateInstanceData: (id: string, update: ServerDataUpdate) => Promise<void>
    onEvent: (callback: (event: ServerEvent) => void) => () => void
  }
  project: {
    open: () => Promise<{ path: string; data: ProjectData } | null>
    openPath: (path: string) => Promise<{ path: string; data: ProjectData }>
    save: (data: ProjectData, path?: string, saveAs?: boolean) => Promise<string | null>
    listRecent: () => Promise<RecentProject[]>
    removeRecent: (path: string) => Promise<RecentProject[]>
  }
  dictionary: {
    export: (items: RegisterDefinition[]) => Promise<string | null>
    import: () => Promise<RegisterDefinition[] | null>
  }
  log: {
    export: (items: PacketLogItem[]) => Promise<string | null>
  }
}
