import { Context, Schema } from 'koishi'
// 动态导入 mc-server-util
let getMinecraftServerStatus: any
import('mc-server-util').then(m => {
  getMinecraftServerStatus = m.getMinecraftServerStatus
})

export const name = 'minecraft-search'

// 服务器配置接口
export interface ServerConfig {
  id: number
  name: string
  host: string
  minekuaiInstanceId?: string
  // 查询配置
  timeout?: number
  serverType?: 'java' | 'bedrock'
}

export interface Config {
  servers: ServerConfig[]
  minekuaiSettings: MinekuaiSettings
}

// 麦块联机配置接口
export interface MinekuaiSettings {
  apiUrl: string
  apiKey: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    servers: Schema.array(Schema.object({
      id: Schema.number().required().description('服务器ID'),
      name: Schema.string().required().description('服务器名称'),
      host: Schema.string().required().description('服务器地址'),
      serverType: Schema.union(['java', 'bedrock']).default('java').description('服务器类型'),
      timeout: Schema.number().default(5.0).description('查询超时时间(秒)'),
      minekuaiInstanceId: Schema.string().description('麦块实例ID (可选)'),
    })).description('服务器列表').role('table').required()
  }).description('服务器配置'),

  Schema.object({
    minekuaiSettings: Schema.object({
      apiUrl: Schema.string().description('麦块API地址').default('https://minekuai.com/api/client'),
      apiKey: Schema.string().description('麦块API密钥'),
    })
  }).description('麦块联机配置(可选)')
])

export function apply(ctx: Context, config: Config) {
  // 解析服务器地址，分离host和port
  function parseServerAddress(hostString: string, defaultPort: number) {
    // 检查是否包含端口号
    if (hostString.includes(':')) {
      const [host, portStr] = hostString.split(':')
      const port = parseInt(portStr)
      return {
        host: host,
        port: isNaN(port) ? defaultPort : port
      }
    }
    return {
      host: hostString,
      port: defaultPort
    }
  }

  // 麦块API请求函数
  async function minekuaiApiRequest(instanceId: string, operation: string, maxRetries = 3) {
    const { apiUrl, apiKey } = config.minekuaiSettings
    if (!apiKey) throw new Error('麦块API密钥未配置')
    if (!apiUrl) throw new Error('麦块API地址未配置')

    const baseUrl = apiUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/servers/${instanceId}/power`
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }
    const body = JSON.stringify({ signal: operation })

    let lastError: Error
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await ctx.http.post(url, body, { headers })
        ctx.logger.info(`麦块API请求成功: 实例 ${instanceId} 操作 ${operation} (第${attempt}次尝试)`)
        return response
      } catch (error) {
        lastError = error
        ctx.logger.warn(`麦块API请求失败 (第${attempt}次尝试):`, error)
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
        }
      }
    }
    throw new Error(`麦块API请求失败，已重试${maxRetries}次: ${lastError.message}`)
  }

  // 查询单个服务器状态
  async function queryServerStatus(server: ServerConfig) {
    try {
      // 确保 getMinecraftServerStatus 已经被导入
      if (!getMinecraftServerStatus) {
        throw new Error('mc-server-util 模块未正确加载')
      }

      const defaultPort = server.serverType === 'bedrock' ? 19132 : 25565
      const { host, port } = parseServerAddress(server.host, defaultPort)

      const timeout = (server.timeout || 5.0) * 1000 // 转换为毫秒

      let result
      if (server.serverType === 'bedrock') {
        // Bedrock版本暂时不支持，因为 mc-server-util 主要支持 Java 版本
        throw new Error('Bedrock服务器暂不支持')
      } else {
        result = await getMinecraftServerStatus(host, port, {
          timeout: timeout,
          debug: false
        })
      }

      return {
        success: true,
        data: result,
        server: server
      }
    } catch (error) {
      // 连接失败时显示具体错误原因，翻译成中文并移除IP
      let errorMessage = error instanceof Error ? error.message : String(error)

      // 翻译常见错误信息
      errorMessage = errorMessage.replace(/connect ECONNREFUSED/i, '服务器已关闭')
      errorMessage = errorMessage.replace(/connect ETIMEDOUT/i, '服务器连接超时')
      errorMessage = errorMessage.replace(/connect ENOTFOUND/i, 'DNS服务器配置错误')
      errorMessage = errorMessage.replace(/getaddrinfo EAI_AGAIN/i, 'DNS服务器配置错误')
      
      // 移除IP:端口和域名
      errorMessage = errorMessage.replace(/\s+(\d+\.\d+\.\d+\.\d+):\d+/, '')
      errorMessage = errorMessage.replace(/\s+[\w.-]+$/, '')

      return {
        success: false,
        error: errorMessage,
        server: server
      }
    }
  }

  // 格式化简短信息
  function formatShortStatus(result: any, server: ServerConfig) {
    if (!result.online) {
      return `🔴 ${server.name} - 离线`
    }

    const players = result.players ? `${result.players.online}/${result.players.max}` : 'N/A'
    const version = result.version ? result.version.name : 'N/A'

    return `🟢 ${server.name} - 在线 | 玩家: ${players} | 版本: ${version}`
  }

  // 格式化详细信息
  function formatDetailedStatus(result: any, server: ServerConfig) {
    if (!result.online) {
      return `🔴 服务器 ${server.name} (${server.host}) 当前离线`
    }

    // 处理MOTD，将换行符替换为空格
    let motdText = '暂无描述'
    if (result.description) {
      // 确保 description 是字符串
      let descriptionStr = result.description
      if (typeof descriptionStr !== 'string') {
        // 如果是对象，尝试转换为字符串
        if (typeof descriptionStr === 'object' && descriptionStr !== null) {
          // 检查是否有 text 属性（某些版本的 mc-server-util 可能返回对象）
          if (descriptionStr.text) {
            descriptionStr = descriptionStr.text
          } else {
            descriptionStr = JSON.stringify(descriptionStr)
          }
        } else {
          descriptionStr = String(descriptionStr)
        }
      }
      // 移除Minecraft颜色代码（§开头的代码）
      descriptionStr = descriptionStr.replace(/§[0-9a-fk-or]/gi, '')
      // 替换所有换行符为空格，并去除多余空格
      motdText = descriptionStr.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    }

    const defaultPort = server.serverType === 'bedrock' ? 19132 : 25565
    const { host, port } = parseServerAddress(server.host, defaultPort)

    let message = `🟢 ${server.name} 状态信息\n`
    message += `📡 地址: ${host}:${port}\n`
    message += `🎮 类型: ${server.serverType || 'Java'}\n`

    if (result.version) {
      message += `📦 版本: ${result.version.name}\n`
    }

    if (result.players) {
      message += `👥 人数: ${result.players.online}/${result.players.max}\n`
      if (result.players.sample && result.players.sample.length > 0) {
        const allPlayers = result.players.sample.map(p => p.name).join(', ')
        message += `👤 在线玩家: ${allPlayers}\n`
      }
    }

    message += `📋 MOTD: ${motdText}\n`
    message += `⏰ 查询时间: ${new Date().toLocaleString('zh-CN')}`

    return message
  }

  // 修改查服指令
  ctx.command('mc/查服 [id:number]', '查询Minecraft服务器状态')
    .action(async ({ session }, id) => {
      // 不带参数：查询全部服务器
      if (id === undefined) {
        if (config.servers.length === 0) {
          return '❌ 未配置任何服务器'
        }

        // 同步查询所有服务器
        const queries = config.servers.map(server => queryServerStatus(server))
        const results = await Promise.all(queries)

        // 计算在线服务器数量
        const onlineCount = results.filter(r => r.success && r.data && r.data.online).length

        let message = `📊 服务器状态汇总 (当前在线${onlineCount}/${results.length}台)\n\n`
        results.forEach((result) => {
          // 使用服务器配置中的ID，而不是数组索引
          const serverId = result.server.id
          if (result.success) {
            // 直接获取完整的格式化状态，在前面添加服务器ID
            const originalStatus = formatShortStatus(result.data, result.server)
            message += `[ID:${serverId}] ${originalStatus}\n`
          } else {
            // 显示具体错误原因
            message += `[ID:${serverId}] 🔴 ${result.server.name} - 离线 | 原因：${result.error}\n`
          }
        })

        // 更新提示信息
        message += `\n💡 输入"查服+服务器ID"即可查询详细状态，例如：查服 ${config.servers[0]?.id || 1}`

        return message
      }

      // 带参数：查询指定服务器
      const server = config.servers.find(s => s.id === id)
      if (!server) {
        return `❌ 未找到ID为 ${id} 的服务器`
      }

      const result = await queryServerStatus(server)
      if (!result.success) {
        // 显示具体错误原因
        return `🔴 服务器 ${server.name} - 离线 | 原因：${result.error}`
      }

      return formatDetailedStatus(result.data, server)
    })

  // 原有的开服和重启指令（保持不变）
  ctx.command('mc/开服 <id:number>', '启动麦块服务器')
    .action(async ({ session }, id) => {
      if (!id) return '请提供服务器ID，例如：开服 1'

      const server = config.servers.find(s => s.id === id)
      if (!server) return `未找到ID为 ${id} 的服务器`
      if (!server.minekuaiInstanceId) return `服务器 ${server.name} 未配置麦块实例ID`

      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'start', 3)
        return `✅ 已发送启动指令到服务器 ${server.name} (ID: ${id})`
      } catch (error) {
        return `❌ 启动服务器 ${server.name} 失败: ${error.message}`
      }
    })

  ctx.command('mc/重启 <id:number>', '重启麦块服务器')
    .action(async ({ session }, id) => {
      if (!id) return '请提供服务器ID，例如：重启 1'

      const server = config.servers.find(s => s.id === id)
      if (!server) return `未找到ID为 ${id} 的服务器`
      if (!server.minekuaiInstanceId) return `服务器 ${server.name} 未配置麦块实例ID`

      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'restart', 3)
        return `✅ 服务器 ${server.name} 重启指令已发送完成，请稍后检查服务器状态`
      } catch (error) {
        return `❌ 重启服务器 ${server.name} 失败: ${error.message}`
      }
    })

  ctx.command('mc/强制重启 <id:number>', '强制重启麦块服务器')
    .action(async ({ session }, id) => {
      if (!id) return '请提供服务器ID，例如：强制重启 1'

      const server = config.servers.find(s => s.id === id)
      if (!server) return `未找到ID为 ${id} 的服务器`
      if (!server.minekuaiInstanceId) return `服务器 ${server.name} 未配置麦块实例ID`

      try {
        // 第一步：发送停止指令
        //session.send(`🔄 正在停止服务器 ${server.name}...`)
        await minekuaiApiRequest(server.minekuaiInstanceId, 'stop', 3)

        // 等待1秒
        await new Promise(resolve => setTimeout(resolve, 1000))

        // 第二步：发送强制停止指令
        //session.send(`⏹️ 正在强制停止服务器 ${server.name}...`)
        await minekuaiApiRequest(server.minekuaiInstanceId, 'kill', 3)

        // 等待3秒
        await new Promise(resolve => setTimeout(resolve, 3000))

        // 第三步：发送启动指令
        //session.send(`🚀 正在启动服务器 ${server.name}...`)
        await minekuaiApiRequest(server.minekuaiInstanceId, 'start', 3)

        return `✅ 服务器 ${server.name} 强制重启指令已发送完成，请稍后检查服务器状态`
      } catch (error) {
        return `❌ 强制重启服务器 ${server.name} 失败: ${error.message}`
      }
    })

  // 新增：查看服务器资源使用情况
  ctx.command('mc/资源 <id:number>', '查看麦块服务器资源使用情况')
    .action(async ({ session }, id) => {
      if (!id) return '请提供服务器ID，例如：资源 1'

      const server = config.servers.find(s => s.id === id)
      if (!server) return `未找到ID为 ${id} 的服务器`
      if (!server.minekuaiInstanceId) return `服务器 ${server.name} 未配置麦块实例ID`

      try {
        const { apiUrl, apiKey } = config.minekuaiSettings
        if (!apiKey) throw new Error('麦块API密钥未配置')
        if (!apiUrl) throw new Error('麦块API地址未配置')

        const baseUrl = apiUrl.replace(/\/+$/, '')
        const url = `${baseUrl}/servers/${server.minekuaiInstanceId}/resources`
        const headers = {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }

        const response = await ctx.http.get(url, { headers })
        ctx.logger.info(`麦块API资源查询成功: 实例 ${server.minekuaiInstanceId}`)

        // 解析API返回结构
        const attributes = response.attributes
        const resources = attributes.resources
        const currentState = attributes.current_state
        const isSuspended = attributes.is_suspended

        // 计算资源使用情况
        const memoryUsed = resources.memory_bytes / 1024 / 1024 / 1024 // 转换为GB
        const cpuUsage = resources.cpu_absolute
        const diskUsed = resources.disk_bytes / 1024 / 1024 / 1024 // 转换为GB
        const uptime = resources.uptime // 秒

        // 格式化运行时间
        const uptimeDays = Math.floor(uptime / 86400)
        const uptimeHours = Math.floor((uptime % 86400) / 3600)
        const uptimeMinutes = Math.floor((uptime % 3600) / 60)
        const uptimeSeconds = uptime % 60
        const formattedUptime = `${uptimeDays}天 ${uptimeHours}小时 ${uptimeMinutes}分钟 ${uptimeSeconds}秒`

        // 格式化资源使用情况
        let message = `📊 ${server.name} 资源使用情况\n`
        message += `� 状态: ${currentState === 'running' ? '运行中' : currentState}\n`
        message += `🔄 暂停: ${isSuspended ? '是' : '否'}\n`
        message += `🖥️ CPU: ${cpuUsage.toFixed(2)}%\n`
        message += `💾 内存: ${memoryUsed.toFixed(2)}GB\n`
        message += `💿 磁盘: ${diskUsed.toFixed(2)}GB\n`
        message += `📡 网络接收: ${(resources.network_rx_bytes / 1024 / 1024).toFixed(2)}MB\n`
        message += `📡 网络发送: ${(resources.network_tx_bytes / 1024 / 1024).toFixed(2)}MB\n`
        message += `⏱️ 运行时间: ${formattedUptime}\n`
        message += `⏰ 查询时间: ${new Date().toLocaleString('zh-CN')}`

        return message
      } catch (error) {
        return `❌ 查询服务器 ${server.name} 资源使用情况失败: ${error.message}`
      }
    })
}