import { Context, Schema, h } from 'koishi'

export const name = 'minecraft-status'

// 服务器配置接口
export interface ServerConfig {
  id: number
  name: string
  host: string
  minekuaiInstanceId?: string // 新增：麦块实例ID
}

export interface Config {
  servers: ServerConfig[]
  minekuaiSettings: MinekuaiSettings // 新增：麦块联机配置
  cacheDuration: number // 新增：缓存时间（毫秒）
}

// 新增：麦块联机配置接口
export interface MinekuaiSettings {
  apiUrl: string
  apiKey: string
}

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    servers: Schema.array(Schema.object({
      id: Schema.number().required().description('服务器ID (数字)'),
      name: Schema.string().required().description('服务器名称'),
      host: Schema.string().required().description('服务器地址 (如: play.example.com)'),
      minekuaiInstanceId: Schema.string().description('麦块实例ID (用于电源控制)')
    })).description('服务器列表').role('table').required(),
    cacheDuration: Schema.number().default(300000).description('缓存时间（毫秒，默认5分钟）')
  }).description('服务器配置'),
  
  // 新增：麦块联机配置分类
  Schema.object({
    minekuaiSettings: Schema.object({
      apiUrl: Schema.string().description('麦块API地址').default('https://minekuai.com/api/client'),
      apiKey: Schema.string().description('麦块API密钥').default('')
    })
  }).description('麦块联机配置')
])

// MOTD API响应接口
interface MOTDResponse {
  type: 'Java' | 'Bedrock'
  status: 'online' | 'offline'
  host: string
  motd: {
    extra: Array<{
      bold: boolean
      italic: boolean
      underlined: boolean
      strikethrough: boolean
      obfuscated: boolean
      color: string
      text: string
    }>
    text: string
  }
  pureMotd: string
  version: string
  protocol: number
  players: {
    online: number
    max: number
    sample: string
  }
  icon: string
  delay: number
  cached: boolean
}

export function apply(ctx: Context, config: Config) {
  const cache = new Map<string, { data: any, timestamp: number }>()

  // 修改后的麦块API请求函数
  async function minekuaiApiRequest(instanceId: string, operation: string, maxRetries = 3) {
    const { apiUrl, apiKey } = config.minekuaiSettings
    if (!apiKey) {
      throw new Error('麦块API密钥未配置')
    }
    if (!apiUrl) {
      throw new Error('麦块API地址未配置')
    }

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

  // MOTD API查询函数
  async function queryMOTD(host: string, port?: number) {
    const cacheKey = `${host}:${port || 'default'}`
    const now = Date.now()
    
    // 检查缓存
    const cached = cache.get(cacheKey)
    if (cached && now - cached.timestamp < config.cacheDuration) {
      return cached.data
    }

    const params: any = { ip: host }
    if (port) params.port = port
    
    try {
      const response = await ctx.http.get<MOTDResponse>('https://motd.minebbs.com/api/status', { params })
      
      // 缓存结果
      cache.set(cacheKey, { data: response, timestamp: now })
      
      return response
    } catch (error) {
      ctx.logger.warn(`MOTD查询失败: ${error.message}`)
      throw new Error(`查询服务器状态失败: ${error.message}`)
    }
  }

  // 解析host字符串（支持 host:port 格式）
  function parseHost(hostString: string): { host: string; port?: number } {
    const [host, portStr] = hostString.split(':')
    const port = portStr ? parseInt(portStr) : undefined
    return { host, port }
  }

  // 格式化MOTD文本（使用pureMotd字段，去除颜色代码和换行符）
  function formatMotd(motdData: MOTDResponse): string {
    // 使用pureMotd字段，它已经去除了颜色代码
    if (motdData.pureMotd) {
      // 将换行符替换为空格
      return motdData.pureMotd.replace(/\n/g, ' ').trim()
    }
    
    // 如果pureMotd不存在，回退到原始MOTD处理
    if (!motdData.motd.extra || motdData.motd.extra.length === 0) {
      return motdData.motd.text || '无描述信息'
    }
    
    const text = motdData.motd.extra.map(item => item.text).join('')
    return text.replace(/\n/g, ' ').trim()
  }

  // 生成简洁状态消息（单行）
  function createBriefStatusMessage(server: ServerConfig, motd: MOTDResponse): string {
    const statusIcon = motd.status === 'online' ? '🟢' : '🔴'
    const statusText = motd.status === 'online' ? '在线' : '离线'
    
    if (motd.status === 'online') {
      const version = motd.version || '未知'
      return `${statusIcon} ${server.name} | ${statusText} | 玩家: ${motd.players.online}/${motd.players.max} | 版本: ${version}`
    } else {
      return `${statusIcon} ${server.name} | ${statusText} | 玩家: 离线 | 版本: 未知`
    }
  }

  // 生成所有服务器的简洁状态汇总
  function createAllServersBriefStatus(servers: ServerConfig[], statuses: Array<{server: ServerConfig, motd?: MOTDResponse, error?: string}>) {
    const onlineCount = statuses.filter(s => s.motd?.status === 'online').length
    const totalCount = servers.length
    
    const serverLines = statuses.map(({server, motd, error}) => {
      if (error) {
        return `🔴 ${server.name} | 查询失败`
      }
      return createBriefStatusMessage(server, motd)
    })
    
    return `服务器状态监控 (${onlineCount}/${totalCount} 在线)\n` + serverLines.join('\n')
  }

  // 生成详细状态消息（按照新格式）
  function createDetailStatusMessage(server: ServerConfig, motd: MOTDResponse) {
    const statusIcon = motd.status === 'online' ? '🟢' : '🔴'
    const statusText = motd.status === 'online' ? '在线' : '离线'
    
    const fields = [
      `🎯 Minecraft 服务器状态`,
      `📝 名称: ${server.name}`,
      `🌐 地址: ${server.host}`,
      `📊 状态: ${statusIcon} ${statusText}`,
      `🎮 类型: ${motd.type}`,
      `🔧 版本: ${motd.version || '未知'}`,
      `👥 在线人数：${motd.status === 'online' ? `${motd.players.online}/${motd.players.max}` : '离线'}`,
    ]

    // 总是显示在线玩家列表，即使无玩家或为Anonymous Player
    if (motd.status === 'online') {
      // 如果玩家样本为空或为"无"，显示"无玩家"
      if (!motd.players.sample || motd.players.sample === '无') {
        fields.push(`👤 在线玩家：无玩家`)
      } else {
        // 正常显示玩家列表，包括Anonymous Player
        fields.push(`👤 在线玩家：${motd.players.sample}`)
      }
    }

    // MOTD描述（使用pureMotd字段，去除颜色代码和换行符）
    fields.push(`📋 描述: ${formatMotd(motd)}`)
    
    // 延迟信息
    fields.push(`⏱️ 延迟: ${motd.delay}ms`)

    return fields.join('\n')
  }

  // 新增：开服指令
  ctx.command('开服 <id:number>', '启动麦块服务器')
    .action(async ({ session }, id) => {
      if (!id) {
        return '请提供服务器ID，例如：开服 1'
      }
      const server = config.servers.find(s => s.id === id)
      if (!server) {
        return `未找到ID为 ${id} 的服务器`
      }
      if (!server.minekuaiInstanceId) {
        return `服务器 ${server.name} 未配置麦块实例ID`
      }
      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'start', 3)
        return `✅ 已发送启动指令到服务器 ${server.name} (ID: ${id})`
      } catch (error) {
        return `❌ 启动服务器 ${server.name} 失败: ${error.message}`
      }
    })

  // 新增：重启指令
  ctx.command('重启 <id:number>', '重启麦块服务器')
    .action(async ({ session }, id) => {
      if (!id) {
        return '请提供服务器ID，例如：重启 1'
      }
      const server = config.servers.find(s => s.id === id)
      if (!server) {
        return `未找到ID为 ${id} 的服务器`
      }
      if (!server.minekuaiInstanceId) {
        return `服务器 ${server.name} 未配置麦块实例ID`
      }
      try {
        await minekuaiApiRequest(server.minekuaiInstanceId, 'restart', 3)
        await new Promise(resolve => setTimeout(resolve, 1000))
        await minekuaiApiRequest(server.minekuaiInstanceId, 'kill', 3)
        return `✅ 已发送重启指令到服务器 ${server.name} (ID: ${id})`
      } catch (error) {
        return `❌ 重启服务器 ${server.name} 失败: ${error.message}`
      }
    })

  // 主查服指令
  ctx.command('查服 [serverId]', '查询 Minecraft 服务器状态')
    .option('refresh', '-r 强制刷新缓存')
    .action(async ({ session, options }, serverId) => {
      // 如果不带参数，查询所有服务器
      if (!serverId) {
        if (config.servers.length === 0) {
          return '暂无服务器配置，请在插件配置中添加服务器。'
        }

        // 查询所有服务器状态
        const statusPromises = config.servers.map(async (server) => {
          try {
            const { host, port } = parseHost(server.host)
            const motd = await queryMOTD(host, port)
            return { server, motd }
          } catch (error) {
            return { server, error: error.message }
          }
        })

        try {
          const statuses = await Promise.all(statusPromises)
          return createAllServersBriefStatus(config.servers, statuses)
        } catch (error) {
          return `查询服务器状态时发生错误: ${error.message}`
        }
      }

      // 如果带参数，查询指定服务器
      const id = parseInt(serverId)
      if (!isNaN(id)) {
        // 参数是数字，按ID查询
        const server = config.servers.find(s => s.id === id)
        if (!server) {
          return `未找到ID为 ${id} 的服务器`
        }
        
        if (options.refresh) {
          const cacheKey = `${server.host}`
          cache.delete(cacheKey)
        }
        
        try {
          const { host, port } = parseHost(server.host)
          const motd = await queryMOTD(host, port)
          return createDetailStatusMessage(server, motd)
        } catch (error) {
          return `查询服务器 ${server.name} 状态失败: ${error.message}`
        }
      } else {
        // 参数是字符串，按地址查询
        try {
          const { host, port } = parseHost(serverId)
          const motd = await queryMOTD(host, port)
          const tempServer: ServerConfig = { id: 0, name: serverId, host: serverId }
          return createDetailStatusMessage(tempServer, motd)
        } catch (error) {
          return `查询服务器 ${serverId} 状态失败: ${error.message}`
        }
      }
    })

  // 定时清理过期缓存
  setInterval(() => {
    const now = Date.now()
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp > config.cacheDuration) {
        cache.delete(key)
      }
    }
  }, 60000) // 每分钟清理一次
}