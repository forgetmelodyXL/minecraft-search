import { Context, Schema } from 'koishi'

let getMinecraftServerStatus: any
import('mc-server-util').then(m => {
  getMinecraftServerStatus = m.getMinecraftServerStatus
})

export const name = 'minecraft-search'

export interface ServerConfig {
  id: number
  userId: string
  groupId: string
  name: string
  host: string
  port: number
  serverType: 'java' | 'bedrock'
  timeout: number
  minekuaiInstanceId?: string
  active: boolean
}

export interface ApiKeyConfig {
  id: number
  userId: string
  groupId: string
  apiKey: string
}

export interface Config {
  minekuaiApiUrl: string
  showIpInDetail: boolean
  enablePermissionCheck: boolean
  allowMemberPowerCommands: boolean
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    minekuaiApiUrl: Schema.string().description('麦块API地址').default('https://minekuai.com/api/client'),
  }).description('麦块联机配置'),

  Schema.object({
    showIpInDetail: Schema.boolean().default(true).description('在查询详细状态时显示服务器IP地址')
  }).description('显示配置'),

  Schema.object({
    enablePermissionCheck: Schema.boolean().default(false).description('启用管理员权限检查'),
    allowMemberPowerCommands: Schema.boolean().default(true).description('允许普通成员使用开服、重启、强制重启指令')
  }).description('权限配置（仅限onebot机器人使用）')
])

export const inject = {
  required: ['database'],
}

declare module 'koishi' {
  interface Tables {
    minecraft_server: ServerConfig
    minecraft_api_key: ApiKeyConfig
  }
}

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('minecraft_server', {
    id: 'unsigned',
    userId: 'string',
    groupId: 'string',
    name: 'string',
    host: 'string',
    port: 'integer',
    serverType: 'string',
    timeout: 'float',
    minekuaiInstanceId: 'string',
    active: 'boolean',
  }, {
    autoInc: true,
    primary: 'id'
  })

  ctx.model.extend('minecraft_api_key', {
    id: 'unsigned',
    userId: 'string',
    groupId: 'string',
    apiKey: 'string',
  }, {
    autoInc: true,
    primary: 'id'
  })

  function parseServerAddress(hostString: string, defaultPort: number) {
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

  async function minekuaiApiRequest(instanceId: string, operation: string, groupId: string, maxRetries = 3) {
    const apiKeys = await ctx.database.get('minecraft_api_key', { groupId })
    if (!apiKeys || apiKeys.length === 0) {
      throw new Error('本群未配置麦块API密钥，请先使用 绑定API密钥 指令')
    }
    const apiKeyRecord = apiKeys[0]

    const baseUrl = config.minekuaiApiUrl.replace(/\/+$/, '')
    const url = `${baseUrl}/servers/${instanceId}/power`
    const headers = {
      'Authorization': `Bearer ${apiKeyRecord.apiKey}`,
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

  async function queryServerStatus(server: ServerConfig) {
    try {
      if (!getMinecraftServerStatus) {
        throw new Error('mc-server-util 模块未正确加载')
      }

      const { host, port } = parseServerAddress(server.host, server.port || 25565)
      const timeout = (server.timeout || 5.0) * 1000

      let result
      if (server.serverType === 'bedrock') {
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
      let errorMessage = error instanceof Error ? error.message : String(error)

      errorMessage = errorMessage.replace(/connect ECONNREFUSED/i, '服务器已关闭')
      errorMessage = errorMessage.replace(/connect ETIMEDOUT/i, '网络波动，请稍后尝试')
      errorMessage = errorMessage.replace(/connect ENOTFOUND/i, '网络波动，请稍后尝试')
      errorMessage = errorMessage.replace(/getaddrinfo EAI_AGAIN/i, '网络波动，请稍后尝试')

      errorMessage = errorMessage.replace(/\s+(\d+\.\d+\.\d+\.\d+):\d+/, '')
      errorMessage = errorMessage.replace(/\s+[\w.-]+$/, '')
      errorMessage = errorMessage.replace(/\s+[a-zA-Z0-9][a-zA-Z0-9.-]*:[0-9]+/, '')

      return {
        success: false,
        error: errorMessage,
        server: server
      }
    }
  }

  function getServerName(server: ServerConfig) {
    return server.name || 'Minecraft 服务器'
  }

  async function checkPermission(session: any, config: Config, isPowerCommand = false): Promise<string | null> {
    if (!config.enablePermissionCheck) {
      return null
    }

    if (isPowerCommand && config.allowMemberPowerCommands) {
      return null
    }

    const memberInfo = session.event?.member?.roles
    if (!memberInfo || !memberInfo.some((role: any) => role.name === "admin" || role.name === "owner" || role.id === "admin" || role.id === "owner")) {
      return "❌ 仅限管理员和群主使用该指令。"
    }

    return null
  }

  function formatShortStatus(result: any, server: ServerConfig) {
    const displayName = getServerName(server)
    if (!result.online) {
      return `🔴 ${displayName} - 离线`
    }

    const players = result.players ? `${result.players.online}/${result.players.max}` : 'N/A'
    const version = result.version ? result.version.name : 'N/A'

    return `🟢 ${displayName} - 在线 | 玩家: ${players} | 版本: ${version}`
  }

  function formatDetailedStatus(result: any, server: ServerConfig, showIp: boolean) {
    const displayName = getServerName(server)
    if (!result.online) {
      return `🔴 ${displayName} 当前离线`
    }

    let motdText = '暂无描述'
    if (result.description) {
      let descriptionStr = result.description
      if (typeof descriptionStr !== 'string') {
        if (typeof descriptionStr === 'object' && descriptionStr !== null) {
          if (descriptionStr.text) {
            descriptionStr = descriptionStr.text
          } else {
            descriptionStr = JSON.stringify(descriptionStr)
          }
        } else {
          descriptionStr = String(descriptionStr)
        }
      }
      descriptionStr = descriptionStr.replace(/§[0-9a-fk-or]/gi, '')
      motdText = descriptionStr.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    }

    let message = `🟢 ${displayName} 状态信息\n`

    if (showIp) {
      const { host, port } = parseServerAddress(server.host, server.port || 25565)
      message += `📡 地址: ${host}:${port}\n`
    }

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

  ctx.guild()
    .command('mc/查服 [target:text]', '查询Minecraft服务器状态')
    .action(async ({ session }, target) => {
      const servers = await ctx.database.get('minecraft_server', {}) 

      if (target === undefined) {
        // 过滤出活跃的服务器（兼容旧数据：null 也视为活跃）
        const activeServers = servers.filter(server => server.active !== false)
        if (activeServers.length === 0) {
          return '❌ 本群未绑定任何服务器，请先使用 绑定服务器 指令'
        }

        const queries = activeServers.map(server => queryServerStatus(server))
        const results = await Promise.all(queries)

        const onlineCount = results.filter(r => r.success && r.data && r.data.online).length

        let message = `📊 服务器状态汇总 (当前在线${onlineCount}/${results.length}台)\n\n`
        results.forEach((result) => {
          const serverId = result.server.id
          if (result.success) {
            const originalStatus = formatShortStatus(result.data, result.server)
            message += `[ID:${serverId}] ${originalStatus}\n`
          } else {
            message += `[ID:${serverId}] 🔴 ${getServerName(result.server)} - 离线 | 原因：${result.error}\n`
          }
        })

        message += `\n💡 输入"查服+服务器ID"即可查询详细状态，例如：查服 ${activeServers[0]?.id || 1}`
        message += `\n💡 也可以直接输入IP地址查询`

        return message
      }

      // 尝试作为数字ID处理
      const id = parseInt(target)
      if (!isNaN(id)) {
        const server = servers.find(s => s.id === id)
        if (server) {
          // 检查服务器是否活跃（兼容旧数据：null 也视为活跃）
          if (server.active === false) {
            return `❌ 服务器 ${server.name} (ID: ${id}) 处于不活跃状态，无法查询`
          }
          const result = await queryServerStatus(server)
          if (!result.success) {
            return `🔴 ${getServerName(server)} - 离线 | 原因：${result.error}`
          }
          return formatDetailedStatus(result.data, server, config.showIpInDetail)
        }
      }

      // 作为IP地址处理
      const host = String(target)
      const defaultPort = 25565
      const { host: parsedHost, port: parsedPort } = parseServerAddress(host, defaultPort)
      
      // 创建临时服务器配置
      const tempServer: ServerConfig = {
        id: 0,
        userId: session.userId,
        groupId: session.guildId || '',
        name: parsedHost,
        host: parsedHost,
        port: parsedPort,
        serverType: 'java',
        timeout: 5.0,
        active: true,
      }

      const result = await queryServerStatus(tempServer)
      if (!result.success) {
        return `🔴 服务器 - 离线 | 原因：${result.error}`
      }

      return formatDetailedStatus(result.data, tempServer, config.showIpInDetail)
    })

  ctx.guild()
    .command('mc/绑定服务器 <host:string>', '绑定Minecraft服务器')
    .option('name', '-n <name:string>', { fallback: '' })
    .option('timeout', '-t <timeout:number>', { fallback: 5 })
    .option('instance', '-i <instance:string>', { fallback: '' })
    .action(async ({ session, options }, host) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!host) {
        return '请提供服务器地址，例如：绑定服务器+IP地址（不带端口时默认为25565）'
      }

      const groupId = session.guildId
      const userId = session.userId

      const defaultPort = 25565
      const { host: parsedHost, port: parsedPort } = parseServerAddress(host, defaultPort)

      const existingServers = await ctx.database.get('minecraft_server', {
        groupId,
        host: parsedHost,
        port: parsedPort
      })

      if (existingServers.length > 0) {
        return `该服务器已在本群绑定，服务器ID为: ${existingServers[0].id}`
      }

      const createData: any = {
        userId,
        groupId,
        host: parsedHost,
        port: parsedPort,
        serverType: 'java',
        timeout: options.timeout,
        minekuaiInstanceId: options.instance,
        active: true,
      }
      if (options.name) {
        createData.name = options.name
      }

      await ctx.database.create('minecraft_server', createData)

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const newServer = servers[servers.length - 1]

      return `✅ 服务器绑定成功！\n服务器ID: ${newServer.id}\n名称: ${newServer.name || 'Minecraft 服务器'}`
    })

  ctx.guild()
    .command('mc/绑定API密钥 <apiKey:string>', '绑定麦块API密钥')
    .action(async ({ session }, apiKey) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!apiKey) {
        return '请提供API密钥'
      }

      const groupId = session.guildId
      const userId = session.userId

      const existingKeys = await ctx.database.get('minecraft_api_key', { groupId })

      if (existingKeys.length > 0) {
        await ctx.database.set('minecraft_api_key', { groupId }, { apiKey })
        return '✅ API密钥更新成功！'
      }

      await ctx.database.create('minecraft_api_key', {
        userId,
        groupId,
        apiKey
      })

      return '✅ API密钥绑定成功！'
    })

  ctx.guild()
    .command('mc/解绑服务器 <id:number>', '解绑Minecraft服务器')
    .action(async ({ session }, id) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!id) {
        return '请提供服务器ID，例如：解绑服务器 1'
      }

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) {
        return `❌ 未找到ID为 ${id} 的服务器`
      }

      await ctx.database.remove('minecraft_server', { id })

      return `✅ 服务器已解绑`
    })

  ctx.guild()
    .command('mc/修改服务器 <id:number>', '修改Minecraft服务器信息')
    .option('name', '-n <name:string>', { fallback: '' })
    .option('timeout', '-t <timeout:number>', { fallback: 0 })
    .option('instance', '-i <instance:string>', { fallback: '' })
    .action(async ({ session, options }, id) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!id) {
        return '请提供服务器ID，例如：修改服务器 1'
      }

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) {
        return `❌ 未找到ID为 ${id} 的服务器`
      }

      const updates: any = {}
      if (options.name) {
        updates.name = options.name
      }
      if (options.timeout > 0) {
        updates.timeout = options.timeout
      }
      if (options.instance) {
        updates.minekuaiInstanceId = options.instance
      }

      if (Object.keys(updates).length === 0) {
        return '请提供要修改的参数，使用 -n 指定新名称，-t 指定新超时时间，-i 指定新麦块实例ID'
      }

      await ctx.database.set('minecraft_server', { id }, updates)

      const parts = []
      if (updates.name) parts.push(`名称: ${updates.name}`)
      if (updates.timeout) parts.push(`超时: ${updates.timeout}秒`)
      if (updates.minekuaiInstanceId) parts.push(`麦块实例ID: ${updates.minekuaiInstanceId}`)

      return `✅ 服务器信息已更新！\n${parts.join('\n')}`
    })

  ctx.guild()
    .command('mc/开服 <id:number>', '启动麦块服务器')
    .action(async ({ session }, id) => {
      const permissionError = await checkPermission(session, config, true)
      if (permissionError) {
        return permissionError
      }

      if (!id) return '请提供服务器ID，例如：开服 1'

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) return `❌ 未找到ID为 ${id} 的服务器，请确保操作的是本群绑定的服务器`
      if (!server.minekuaiInstanceId) return `${server.name} 未配置麦块实例ID`

      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'start', groupId, 3)
        return `✅ 已发送启动指令到 ${server.name} (ID: ${id})`
      } catch (error) {
        return `❌ 启动服务器失败: ${error.message}`
      }
    })

  ctx.guild()
    .command('mc/重启 <id:number>', '重启麦块服务器')
    .action(async ({ session }, id) => {
      const permissionError = await checkPermission(session, config, true)
      if (permissionError) {
        return permissionError
      }

      if (!id) return '请提供服务器ID，例如：重启 1'

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) return `❌ 未找到ID为 ${id} 的服务器，请确保操作的是本群绑定的服务器`
      if (!server.minekuaiInstanceId) return `${server.name} 未配置麦块实例ID`

      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'restart', groupId, 3)
        return `✅ ${server.name} 重启指令已发送完成，请稍后检查服务器状态`
      } catch (error) {
        return `❌ 重启服务器失败: ${error.message}`
      }
    })

  ctx.guild()
    .command('mc/强制重启 <id:number>', '强制重启麦块服务器')
    .action(async ({ session }, id) => {
      const permissionError = await checkPermission(session, config, true)
      if (permissionError) {
        return permissionError
      }

      if (!id) return '请提供服务器ID，例如：强制重启 1'

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) return `❌ 未找到ID为 ${id} 的服务器，请确保操作的是本群绑定的服务器`
      if (!server.minekuaiInstanceId) return `${server.name} 未配置麦块实例ID`

      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'stop', groupId, 3)
        await new Promise(resolve => setTimeout(resolve, 1000))
        await minekuaiApiRequest(server.minekuaiInstanceId, 'kill', groupId, 3)
        await new Promise(resolve => setTimeout(resolve, 3000))
        await minekuaiApiRequest(server.minekuaiInstanceId, 'start', groupId, 3)

        return `✅ ${server.name} 强制重启指令已发送完成，请稍后检查服务器状态`
      } catch (error) {
        return `❌ 强制重启服务器失败: ${error.message}`
      }
    })

  ctx.guild()
    .command('mc/资源 <id:number>', '查看麦块服务器资源使用情况')
    .action(async ({ session }, id) => {
      if (!id) return '请提供服务器ID，例如：资源 1'

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) return `❌ 未找到ID为 ${id} 的服务器，请确保操作的是本群绑定的服务器`
      if (!server.minekuaiInstanceId) return `${server.name} 未配置麦块实例ID`

      try {
        const apiKeys = await ctx.database.get('minecraft_api_key', { groupId })
        if (!apiKeys || apiKeys.length === 0) {
          throw new Error('本群未配置麦块API密钥，请先使用 绑定API密钥 指令')
        }
        const apiKeyRecord = apiKeys[0]

        const baseUrl = config.minekuaiApiUrl.replace(/\/+$/, '')
        const url = `${baseUrl}/servers/${server.minekuaiInstanceId}/resources`
        const headers = {
          'Authorization': `Bearer ${apiKeyRecord.apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }

        const response = await ctx.http.get(url, { headers })
        ctx.logger.info(`麦块API资源查询成功: 实例 ${server.minekuaiInstanceId}`)

        const attributes = response.attributes
        const resources = attributes.resources
        const currentState = attributes.current_state
        const isSuspended = attributes.is_suspended

        const memoryUsed = resources.memory_bytes / 1024 / 1024 / 1024
        const cpuUsage = resources.cpu_absolute
        const diskUsed = resources.disk_bytes / 1024 / 1024 / 1024
        const uptime = resources.uptime

        const uptimeDays = Math.floor(uptime / 86400)
        const uptimeHours = Math.floor((uptime % 86400) / 3600)
        const uptimeMinutes = Math.floor((uptime % 3600) / 60)
        const uptimeSeconds = uptime % 60
        const formattedUptime = `${uptimeDays}天 ${uptimeHours}小时 ${uptimeMinutes}分钟 ${uptimeSeconds}秒`

        let message = `📊 ${server.name} 资源使用情况\n`
        message += `📋 状态: ${currentState === 'running' ? '运行中' : currentState}\n`
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
        return `❌ 查询服务器资源使用情况失败: ${error.message}`
      }
    })

  ctx.guild()
    .command('mc/服务器列表', '查看已绑定的服务器列表')
    .action(async ({ session }) => {
      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })

      if (servers.length === 0) {
        return '本群暂未绑定任何服务器'
      }

      let message = `📋 本群已绑定 ${servers.length} 台服务器：\n\n`
      servers.forEach(server => {
        // 兼容旧数据：null 也视为活跃
        const activeStatus = server.active === false ? '� 不活跃' : '� 活跃'
        message += `[ID:${server.id}] ${server.name} | ${activeStatus}\n`
        if (config.showIpInDetail) {
          message += `  地址: ${server.host}:${server.port}\n`
        }
        message += `  类型: ${server.serverType} | 超时: ${server.timeout}秒\n`
        if (server.minekuaiInstanceId) {
          message += `  麦块实例: ${server.minekuaiInstanceId}\n`
        }
        message += '\n'
      })

      return message.trim()
    })

  ctx.guild()
    .command('mc/设置实例 <id:number> <instanceId:string>', '设置服务器的麦块实例ID')
    .action(async ({ session }, id, instanceId) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!id || !instanceId) {
        return '请提供服务器ID和实例ID，例如：设置实例 1 abc123'
      }

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) {
        return `❌ 未找到ID为 ${id} 的服务器`
      }

      await ctx.database.set('minecraft_server', { id }, { minekuaiInstanceId: instanceId })

      return `✅ ${server.name} 的麦块实例ID已设置为: ${instanceId}`
    })

  ctx.guild()
    .command('mc/服务器状态 <id:number> [status:text]', '查询或设置服务器活跃状态')
    .action(async ({ session }, id, status) => {
      const permissionError = await checkPermission(session, config)
      if (permissionError) {
        return permissionError
      }

      if (!id) {
        return '请提供服务器ID，例如：服务器状态 1'
      }

      const groupId = session.guildId

      const servers = await ctx.database.get('minecraft_server', { groupId })
      const server = servers.find(s => s.id === id)

      if (!server) {
        return `❌ 未找到ID为 ${id} 的服务器`
      }

      if (!status) {
        // 查询状态（兼容旧数据：null 也视为活跃）
        const activeStatus = server.active === false ? '� 不活跃' : '� 活跃'
        return `📋 ${server.name} (ID: ${id}) 状态：${activeStatus}`
      } else if (status === '启用') {
        // 设置为活跃
        await ctx.database.set('minecraft_server', { id }, { active: true })
        return `✅ ${server.name} (ID: ${id}) 已设置为活跃状态`
      } else if (status === '停用') {
        // 设置为不活跃
        await ctx.database.set('minecraft_server', { id }, { active: false })
        return `✅ ${server.name} (ID: ${id}) 已设置为不活跃状态`
      } else {
        return '请使用正确的状态值：启用 或 停用'
      }
    })
}