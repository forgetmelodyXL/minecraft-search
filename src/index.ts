import { Context, Schema } from 'koishi'

export const name = 'minecraft-search'

export interface ServerConfig {
  id: number // 改为数字类型
  name: string
  host: string
  port: number
}

export interface MinekuaiConfig {
  apiKey: string
  baseUrl?: string
}

export interface Config {
  servers: ServerConfig[]
  minekuai?: MinekuaiConfig
}

export const Config: Schema<Config> = Schema.object({
  servers: Schema.array(Schema.object({
    id: Schema.number().description('服务器ID'), // 改为数字类型
    name: Schema.string().description('服务器名称'),
    host: Schema.string().description('服务器地址'),
    port: Schema.number().description('服务器端口').default(25565),
  }))
    .description('Minecraft服务器列表')
    .role('table')
    .collapse()
    .required(),

  minekuai: Schema.object({
    apiKey: Schema.string().description('麦块联机API密钥'),
    baseUrl: Schema.string().description('API基础URL').default('https://minekuai.com/api/client'),
  })
    .description('麦块联机配置')
})

// 去除Minecraft格式符号的辅助函数
function removeFormatting(str: string): string {
  return str.replace(/§[0-9a-fk-or]/g, '')
}

// 麦块联机API请求函数
async function minekuaiRequest(ctx: Context, config: MinekuaiConfig, endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any) {
  const url = `${config.baseUrl}${endpoint}`
  const headers = {
    'Authorization': `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  }

  try {
    if (method === 'GET') {
      return await ctx.http.get(url, { headers })
    } else {
      return await ctx.http.post(url, data, { headers })
    }
  } catch (error) {
    ctx.logger('minecraft-search').warn(`麦块联机API请求失败: ${endpoint}`, error)

    let errorMessage = error.message
    try {
      if (error.response && error.response.data) {
        if (error.response.data.errors) {
          const apiError = error.response.data.errors[0]
          errorMessage = `[${apiError.status}] ${apiError.code}: ${apiError.detail}`
        } else if (error.response.data.message) {
          errorMessage = error.response.data.message
        }
      }
    } catch (e) { }

    throw new Error(errorMessage)
  }
}

export function apply(ctx: Context, config: Config) {
  // 原有的Minecraft查服功能
  ctx.command('mc/查服 [serverName:string]')
    .action(async ({ session }, serverName) => {
      const { servers } = config

      if (!servers || servers.length === 0) {
        return '未配置任何Minecraft服务器'
      }

      if (serverName) {
        // 尝试按ID查找（如果输入是数字）
        if (!isNaN(Number(serverName))) {
          const id = parseInt(serverName)
          const targetServer = servers.find(server => server.id === id)
          if (targetServer) {
            return await queryServer(targetServer)
          }
        }

        // 尝试按名称查找
        const targetServer = servers.find(server =>
          server.name.toLowerCase() === serverName.toLowerCase()
        )

        if (!targetServer) {
          return `未找到"${serverName}"对应的服务器。可用服务器: ${servers.map(s => `${s.id}(${s.name})`).join(', ')}`
        }

        return await queryServer(targetServer)
      }

      const results = []
      for (const server of servers) {
        try {
          const result = await queryServer(server)
          results.push(result)
        } catch (error) {
          results.push(`❌ ${server.id} ${server.name} 查询失败: ${error.message}`)
        }
      }

      return results.join('\n\n')
    })

  async function queryServer(server: ServerConfig) {
    const hostWithPort = `${server.host}:${server.port}`
    const apiUrl = `https://motd.minebbs.com/api/status?ip=${server.host}&port=${server.port}`

    try {
      const response = await ctx.http.get(apiUrl)

      if (response.status !== 'online') {
        return `🔴 ${server.id} ${server.name}\n🌐 ${hostWithPort}\n状态: 离线`
      }

      let message = `🟢 ${server.id} ${server.name}\n`
      message += `🌐 IP: ${hostWithPort}\n`
      message += `📝 MOTD: \n${removeFormatting(response.pureMotd || response.motd?.text || '无')}\n`
      message += `🎮 版本: ${response.version} (协议 ${response.protocol})\n`
      message += `👥 玩家: ${response.players.online}/${response.players.max}\n`
      message += `⏱️ 延迟: ${response.delay}ms\n`

      if (response.players.online > 0 && response.players.sample) {
        const playerNames = Array.isArray(response.players.sample)
          ? response.players.sample
          : response.players.sample.split(', ')
        message += `🎯 在线玩家: ${playerNames.join(', ')}`
      } else if (response.players.online > 0) {
        message += '🎯 在线玩家: 有玩家在线但未获取到列表'
      } else {
        message += '🎯 当前没有在线玩家'
      }

      return message
    } catch (error) {
      ctx.logger('minecraft-search').warn(`查询服务器 ${server.id} ${server.name} 失败`, error)
      throw new Error(`查询失败: ${error.message}`)
    }
  }

  ctx.command('mc/服务器列表')
    .action(async ({ session }) => {
      const { servers } = config

      if (!servers || servers.length === 0) {
        return '未配置任何Minecraft服务器'
      }

      // 按ID排序
      const sortedServers = [...servers].sort((a, b) => a.id - b.id)

      const serverList = sortedServers.map(server =>
        `• ${server.id}. ${server.name} - ${server.host}:${server.port}`
      ).join('\n')

      return `📋 已配置的Minecraft服务器:\n${serverList}\n\n使用"mc/查服 ID或名称"查询特定服务器`
    })

  // 麦块联机功能
  if (config.minekuai?.apiKey) {
    const minekuaiConfig = config.minekuai

    // 麦块联机实例列表
    ctx.command('麦块/实例列表', { authority: 3 })
      .action(async ({ session }) => {
        try {
          const response = await minekuaiRequest(ctx, minekuaiConfig, '/')

          if (!response || !response.data || response.data.length === 0) {
            return '❌ 未找到任何麦块联机实例'
          }

          let message = '📋 麦块联机实例列表:\n'
          response.data.forEach((instance: any, index: number) => {
            const attrs = instance.attributes
            message += `\n${index + 1}. ${removeFormatting(attrs.name || attrs.identifier)}\n`
            message += `   🔧 标识符: ${attrs.identifier}\n`
            message += `   📊 节点: ${attrs.node}\n`
            message += `   💾 内存: ${attrs.limits.memory}MB\n`
            message += `   ⏰ 到期: ${attrs.exp_date}\n`
          })

          return message
        } catch (error) {
          return `❌ 获取实例列表失败: ${error.message}`
        }
      })

    // 麦块联机实例信息
    ctx.command('麦块/实例信息 <identifier:string>', { authority: 3 })
      .action(async ({ session }, identifier) => {
        if (!identifier) {
          return '❌ 请提供实例标识符'
        }

        try {
          const response = await minekuaiRequest(ctx, minekuaiConfig, `/servers/${identifier}`)

          if (!response || !response.attributes) {
            return '❌ 未找到指定实例'
          }

          const attrs = response.attributes
          const allocations = attrs.relationships?.allocations?.data || []
          const defaultAllocation = allocations.find((alloc: any) => alloc.attributes.is_default) || allocations[0]

          let message = `🖥️ 实例信息: ${removeFormatting(attrs.name || identifier)}\n`
          message += `🔧 标识符: ${identifier}\n`
          message += `📝 描述: ${removeFormatting(attrs.description || '无')}\n`
          message += `🌐 节点: ${attrs.node}\n`
          message += `📊 状态: ${attrs.is_suspended ? '已暂停' : attrs.is_installing ? '安装中' : '运行中'}\n`
          message += `⏰ 到期时间: ${attrs.exp_date}\n`
          message += `💾 内存: ${attrs.limits.memory}MB\n`
          message += `⚡ CPU: ${attrs.limits.cpu}%\n`
          message += `💿 磁盘: ${attrs.limits.disk}MB\n`

          if (defaultAllocation) {
            const allocAttrs = defaultAllocation.attributes
            message += `🌐 连接地址: ${allocAttrs.ip_alias || allocAttrs.ip}:${allocAttrs.port}\n`
          }

          return message
        } catch (error) {
          return `❌ 获取实例信息失败: ${error.message}`
        }
      })

    // 麦块联机实例资源使用情况
    ctx.command('麦块/实例资源 <identifier:string>', { authority: 3 })
      .action(async ({ session }, identifier) => {
        if (!identifier) {
          return '❌ 请提供实例标识符'
        }

        try {
          const response = await minekuaiRequest(ctx, minekuaiConfig, `/servers/${identifier}/resources`)

          if (!response || !response.attributes) {
            return '❌ 未找到指定实例的资源信息'
          }

          const attrs = response.attributes
          const resources = attrs.resources

          let message = `📊 实例资源使用情况: ${identifier}\n`
          message += `🔧 当前状态: ${attrs.current_state}\n`
          message += `⏸️ 是否暂停: ${attrs.is_suspended ? '是' : '否'}\n`
          message += `💻 CPU使用率: ${(resources.cpu_absolute || 0).toFixed(2)}%\n`
          message += `🧠 内存使用: ${Math.round((resources.memory_bytes || 0) / 1024 / 1024)} MB\n`
          message += `💾 磁盘使用: ${Math.round((resources.disk_bytes || 0) / 1024 / 1024)} MB\n`
          message += `📤 网络上传: ${Math.round((resources.network_tx_bytes || 0) / 1024 / 1024)} MB\n`
          message += `📥 网络下载: ${Math.round((resources.network_rx_bytes || 0) / 1024 / 1024)} MB\n`
          message += `⏰ 运行时间: ${Math.round((resources.uptime || 0) / 1000)} 秒\n`

          return message
        } catch (error) {
          return `❌ 获取资源信息失败: ${error.message}`
        }
      })

    // 麦块联机实例电源控制
    ctx.command('麦块/实例电源 <identifier:string> <action:string>', { authority: 3 })
      .action(async ({ session }, identifier, action) => {
        if (!identifier || !action) {
          return '❌ 请提供实例标识符和操作类型 (start/stop/restart/kill)'
        }

        const validActions = ['start', 'stop', 'restart', 'kill']
        if (!validActions.includes(action)) {
          return `❌ 无效的操作类型。可用操作: ${validActions.join(', ')}`
        }

        try {
          await minekuaiRequest(ctx, minekuaiConfig, `/servers/${identifier}/power`, 'POST', {
            signal: action
          })

          return `✅ 已发送 ${action} 指令到实例 ${identifier}`
        } catch (error) {
          return `❌ 电源操作失败: ${error.message}`
        }
      })

    // 麦块联机实例发送命令
    ctx.command('麦块/实例命令 <identifier:string> <command:text>', { authority: 3 })
      .action(async ({ session }, identifier, command) => {
        if (!identifier || !command) {
          return '❌ 请提供实例标识符和命令内容'
        }

        try {
          await minekuaiRequest(ctx, minekuaiConfig, `/servers/${identifier}/command`, 'POST', {
            command: command
          })

          return `✅ 已发送命令到实例 ${identifier}: ${command}`
        } catch (error) {
          return `❌ 发送命令失败: ${error.message}`
        }
      })

    // 麦块联机账户信息
    ctx.command('麦块/账户信息', { authority: 3 })
      .action(async ({ session }) => {
        try {
          const response = await minekuaiRequest(ctx, minekuaiConfig, '/account')

          if (!response || !response.attributes) {
            return '❌ 获取账户信息失败'
          }

          const attrs = response.attributes
          let message = '👤 麦块联机账户信息:\n'
          message += `📛 用户名: ${attrs.username}\n`
          message += `📧 邮箱: ${attrs.email}\n`
          message += `👤 姓名: ${attrs.first_name} ${attrs.last_name}\n`
          message += `🆔 用户ID: ${attrs.id}\n`
          message += `🔧 管理员: ${attrs.admin ? '是' : '否'}\n`
          message += `🌐 语言: ${attrs.language}\n`

          return message
        } catch (error) {
          return `❌ 获取账户信息失败: ${error.message}`
        }
      })
  }
}