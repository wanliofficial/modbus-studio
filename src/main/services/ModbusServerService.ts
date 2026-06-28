import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'
import { SerialPort } from 'serialport'
import type { ServerConfig, ServerDataUpdate, ServerEvent, ServerInstanceConfig } from '../../shared/types'
import { appendCrc, verifyCrc } from '../protocol/crc16'
import { frameToHex } from '../protocol/rtu-frame'
import { createServerDataModel, processServerPdu, type ServerDataModel } from '../protocol/server-pdu'
import { buildTcpFrame } from '../protocol/tcp-frame'

/**
 * @brief 单个从站实例的运行时状态。
 *
 * 每个实例独立维护四区数据模型、TCP 监听器或 RTU 串口及连接集合。
 */
interface ServerInstance {
  config: ServerInstanceConfig
  data: ServerDataModel
  tcpServer: Server | null
  tcpSockets: Set<Socket>
  serialPort: SerialPort | null
  running: boolean
}

export class ModbusServerService extends EventEmitter {
  private readonly instances = new Map<string, ServerInstance>()

  /**
   * @brief 启动或重启指定从站实例。
   *
   * 若该实例已存在则先停止再以新数据重启，确保运行状态与界面一致。
   * @param instance 实例配置（id、从站地址、端口等）。
   * @param initialData 初始四区数据。
   */
  public async startInstance(instance: ServerInstanceConfig, initialData: ServerDataUpdate[]): Promise<void> {
    await this.stopInstance(instance.id)
    const record: ServerInstance = { config: instance, data: createServerDataModel(), tcpServer: null, tcpSockets: new Set(), serialPort: null, running: false }
    this.instances.set(instance.id, record)
    initialData.forEach((item) => { record.data[item.area][item.address] = item.value })
    const config: ServerConfig = {
      protocol: instance.protocol,
      slaveId: instance.slaveId,
      serial: { path: '', baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', timeout: 1000 },
      tcp: { host: instance.tcpHost, port: instance.tcpPort }
    }
    if (instance.protocol === 'TCP') await this.startTcp(record, config)
    else await this.startRtu(record, config)
    record.running = true
    this.emitServerEvent({ type: 'status', instanceId: instance.id, running: true, protocol: instance.protocol })
  }

  /**
   * @brief 停止指定从站实例。
   *
   * 关闭其 TCP 监听与 RTU 串口，并广播停止状态。
   */
  public async stopInstance(id: string): Promise<void> {
    const instance = this.instances.get(id)
    if (!instance) return
    instance.tcpSockets.forEach((socket) => socket.destroy())
    instance.tcpSockets.clear()
    if (instance.tcpServer) await new Promise<void>((resolve) => instance.tcpServer!.close(() => resolve()))
    if (instance.serialPort?.isOpen) await new Promise<void>((resolve) => instance.serialPort!.close(() => resolve()))
    instance.tcpServer = null
    instance.serialPort = null
    if (instance.running) this.emitServerEvent({ type: 'status', instanceId: id, running: false })
    instance.running = false
    this.instances.delete(id)
  }

  /**
   * @brief 更新指定实例的数据区单个值。
   * @param id 实例 ID。
   * @param update 数据区更新。
   */
  public updateInstanceData(id: string, update: ServerDataUpdate): void {
    const instance = this.instances.get(id)
    if (instance) instance.data[update.area][update.address] = update.value
  }

  /**
   * @brief 停止全部实例。
   *
   * 应用退出或窗口关闭时调用，确保释放所有监听与串口资源。
   */
  public async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((id) => this.stopInstance(id)))
  }

  /** @brief 启动实例的 TCP 监听。详细说明：为每个连接维护独立粘包缓冲区。 */
  private startTcp(instance: ServerInstance, config: ServerConfig): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => this.handleTcpSocket(instance, socket, config.slaveId))
      /** @brief 处理监听成功。 */
      const onListening = (): void => { server.off('error', onError); resolve() }
      /** @brief 处理监听失败。 */
      const onError = (error: Error): void => { server.off('listening', onListening); reject(error) }
      server.once('listening', onListening)
      server.once('error', onError)
      server.listen(config.tcp.port, config.tcp.host)
      instance.tcpServer = server
    })
  }

  /** @brief 处理 TCP 客户端连接。详细说明：按 MBAP 长度拆帧并响应。 */
  private handleTcpSocket(instance: ServerInstance, socket: Socket, slaveId: number): void {
    instance.tcpSockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.once('close', () => instance.tcpSockets.delete(socket))
    socket.on('error', () => instance.tcpSockets.delete(socket))
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 6) {
        const frameLength = 6 + buffer.readUInt16BE(4)
        if (buffer.length < frameLength) break
        const request = buffer.subarray(0, frameLength)
        buffer = buffer.subarray(frameLength)
        if (request[6] !== slaveId) continue
        const responsePdu = processServerPdu(request.subarray(7), instance.data, (update) => this.reportUpdate(instance.config.id, update))
        const response = buildTcpFrame(request.readUInt16BE(0), request[6], responsePdu)
        socket.write(response)
        this.reportLog(instance, 'TCP', request, response)
      }
    })
  }

  /** @brief 启动实例的 RTU 串口。详细说明：按功能码推断帧长并响应。 */
  private async startRtu(instance: ServerInstance, config: ServerConfig): Promise<void> {
    const port = new SerialPort({ path: config.serial.path, baudRate: config.serial.baudRate, dataBits: config.serial.dataBits, stopBits: config.serial.stopBits, parity: config.serial.parity, autoOpen: false })
    await new Promise<void>((resolve, reject) => port.open((error) => error ? reject(error) : resolve()))
    let buffer = Buffer.alloc(0)
    port.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 8) {
        const functionCode = buffer[1]
        const frameLength = functionCode === 15 || functionCode === 16 ? 9 + buffer[6] : 8
        if (buffer.length < frameLength) break
        const request = buffer.subarray(0, frameLength)
        buffer = buffer.subarray(frameLength)
        if (request[0] !== config.slaveId || !verifyCrc(request)) continue
        const responsePdu = processServerPdu(request.subarray(1, -2), instance.data, (update) => this.reportUpdate(instance.config.id, update))
        const response = appendCrc(Buffer.concat([Buffer.from([config.slaveId]), responsePdu]))
        port.write(response)
        this.reportLog(instance, 'RTU', request, response)
      }
    })
    instance.serialPort = port
  }

  /** @brief 上报指定实例的数据变化。 */
  private reportUpdate(instanceId: string, update: ServerDataUpdate): void {
    this.emitServerEvent({ type: 'data', instanceId, update })
  }

  /** @brief 上报指定实例的报文日志。 */
  private reportLog(instance: ServerInstance, protocol: 'RTU' | 'TCP', request: Buffer, response: Buffer): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    const fcIndex = protocol === 'RTU' ? 1 : 7
    this.emitServerEvent({ type: 'log', instanceId: instance.config.id, log: { time, direction: 'RX', protocol, raw: frameToHex(request), parsed: `[${instance.config.name}] 收到功能码 ${request[fcIndex].toString(16).padStart(2, '0').toUpperCase()}`, elapsedMs: 0, status: '成功' } })
    this.emitServerEvent({ type: 'log', instanceId: instance.config.id, log: { time, direction: 'TX', protocol, raw: frameToHex(response), parsed: `[${instance.config.name}] 已响应`, elapsedMs: 0, status: '发送' } })
  }

  /** @brief 广播 Server 事件到主进程 IPC。 */
  private emitServerEvent(event: ServerEvent): void {
    this.emit('server-event', event)
  }
}
