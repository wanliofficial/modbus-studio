import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import type { ReadRegistersParams, TcpConfig, TransactionResult, WriteMultipleRegistersParams, WriteRegisterParams } from '../../shared/types'
import { frameToHex } from '../protocol/rtu-frame'
import { buildTcpReadFrame, buildTcpWriteMultipleCoilsFrame, buildTcpWriteMultipleFrame, buildTcpWriteSingleCoilFrame, buildTcpWriteSingleFrame, parseTcpReadResponse } from '../protocol/tcp-frame'

/**
 * @brief Modbus UDP 客户端服务。
 *
 * Modbus UDP 帧格式与 TCP 相同（MBAP 头 + PDU），但无连接。
 * 连接时保存目标地址和超时，每次事务用一个数据报请求并等待一个数据报响应。
 * 复用与 TcpClientService 相同的接口，便于主进程按协议分发。
 */
export class UdpClientService {
  private socket: UdpSocket | null = null
  private host = '127.0.0.1'
  private port = 502
  private timeout = 1000
  private transactionId = 1

  /**
   * @brief 建立 Modbus UDP 连接。
   *
   * UDP 无连接，此处仅创建套接字并保存目标地址和超时配置。
   * @param config UDP 连接参数（host/port/timeout）。
   */
  public async connect(config: TcpConfig): Promise<void> {
    await this.disconnect()
    this.host = config.host
    this.port = config.port
    this.timeout = config.timeout
    this.socket = createSocket('udp4')
  }

  /** @brief 断开 Modbus UDP 连接。 */
  public async disconnect(): Promise<void> {
    const socket = this.socket
    this.socket = null
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()))
  }

  /**
   * @brief 读取数据（线圈、离散输入或寄存器）。
   *
   * 支持 FC01～04，自动按功能码解包位或寄存器值。
   * @param params 读取参数。
   * @returns UDP 事务结果。
   */
  public async readRegisters(params: ReadRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const request = buildTcpReadFrame(transactionId, params.slaveId, params.functionCode, params.startAddress, params.quantity)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: parseTcpReadResponse(response, transactionId, params.slaveId, params.functionCode, params.quantity), elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入单个线圈（FC05）或保持寄存器（FC06）。
   * @param params 写入参数。
   * @returns UDP 事务结果。
   */
  public async writeSingleRegister(params: WriteRegisterParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const isCoil = params.functionCode === 5
    const request = isCoil
      ? buildTcpWriteSingleCoilFrame(transactionId, params.slaveId, params.address, Boolean(params.value))
      : buildTcpWriteSingleFrame(transactionId, params.slaveId, params.address, params.value)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    if (response.readUInt16BE(0) !== transactionId || response[6] !== params.slaveId || response[7] !== (isCoil ? 0x05 : 0x06)) throw new Error(`Modbus UDP 写响应头不匹配 [${frameToHex(response)}]`)
    if (response.readUInt16BE(8) !== params.address || response.readUInt16BE(10) !== (isCoil ? (params.value ? 0xff00 : 0x0000) : params.value)) throw new Error(`Modbus UDP 写响应地址或值不匹配 [${frameToHex(response)}]`)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: [params.value], elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /**
   * @brief 写入多个线圈（FC15）或保持寄存器（FC16）。
   * @param params 多写入参数。
   * @returns UDP 事务结果。
   */
  public async writeMultipleRegisters(params: WriteMultipleRegistersParams): Promise<TransactionResult> {
    const transactionId = this.nextTransactionId()
    const isCoil = params.functionCode === 15
    const request = isCoil
      ? buildTcpWriteMultipleCoilsFrame(transactionId, params.slaveId, params.startAddress, params.values)
      : buildTcpWriteMultipleFrame(transactionId, params.slaveId, params.startAddress, params.values)
    const startedAt = performance.now()
    const response = await this.transact(request, params.timeout)
    const fc = isCoil ? 0x0f : 0x10
    if (response.readUInt16BE(0) !== transactionId || response[7] !== fc || response.readUInt16BE(8) !== params.startAddress || response.readUInt16BE(10) !== params.values.length) throw new Error(`Modbus UDP 写响应范围不匹配 [${frameToHex(response)}]`)
    return { tx: frameToHex(request), rx: frameToHex(response), registers: params.values, elapsedMs: Math.max(1, Math.round(performance.now() - startedAt)), crcValid: true }
  }

  /** @brief 返回下一个事务标识。 */
  private nextTransactionId(): number {
    const current = this.transactionId
    this.transactionId = this.transactionId >= 0xffff ? 1 : this.transactionId + 1
    return current
  }

  /**
   * @brief 发送 UDP 请求并等待一个完整 MBAP 响应数据报。
   *
   * UDP 无粘包，每个数据报即一帧；按事务标识匹配首个响应。
   * @param request 请求帧。
   * @param timeout 超时毫秒。
   * @returns 响应帧。
   */
  private async transact(request: Buffer, timeout: number): Promise<Buffer> {
    const socket = this.socket
    if (!socket) throw new Error('Modbus UDP 尚未连接')
    const activeSocket = socket
    return new Promise<Buffer>((resolve, reject) => {
      let response: Buffer | null = null
      const timer = setTimeout(() => cleanup(new Error('等待 Modbus UDP 响应超时')), timeout)
      function onMessage(message: Buffer): void { response = message; cleanup() }
      function onError(error: Error): void { cleanup(error) }
      function cleanup(error?: Error): void {
        clearTimeout(timer)
        activeSocket.off('message', onMessage)
        activeSocket.off('error', onError)
        if (error) reject(error)
        else if (response) resolve(response)
      }
      activeSocket.on('message', onMessage)
      activeSocket.on('error', onError)
      activeSocket.send(request, this.port, this.host, (error) => error && cleanup(error))
    })
  }
}
