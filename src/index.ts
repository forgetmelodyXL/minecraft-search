import { Context, Schema } from 'koishi'

export const name = 'minecraft-search'

export interface ServerConfig {
  id: number // 改为数字类型
  name: string
  host: string
  port: number
}

export interface InstanceMapping {
  id: number // 服务器ID
  instanceId: string // 麦块联机实例ID
}

export interface MinekuaiConfig {
  apiKey: string
  baseUrl?: string
  instances?: InstanceMapping[] // 新增实例映射配置
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
    instances: Schema.array(Schema.object({
      id: Schema.number().description('服务器ID（对应上方服务器列表中的ID）'),
      instanceId: Schema.string().description('麦块联机实例ID')
    }))
      .description('服务器与实例关联配置（将服务器ID映射到麦块联机实例ID）')
      .role('table')
      .collapse()
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

// 根据输入解析实例标识符的辅助函数
function resolveInstanceIdentifier(input: string, minekuaiConfig: MinekuaiConfig, servers: ServerConfig[]): string {
  // 如果输入是数字，尝试从映射中查找实例ID
  if (!isNaN(Number(input))) {
    const serverId = parseInt(input)
    const mapping = minekuaiConfig.instances?.find(m => m.id === serverId)
    
    if (mapping) {
      return mapping.instanceId
    } else {
      // 如果没有找到映射，检查是否存在对应的服务器
      const server = servers.find(s => s.id === serverId)
      if (server) {
        throw new Error(`服务器ID ${serverId} (${server.name}) 未配置实例映射关系`)
      } else {
        throw new Error(`未找到ID为 ${serverId} 的服务器`)
      }
    }
  }
  
  // 如果不是数字，直接返回输入作为实例ID
  return input
}

// 获取服务器名称的辅助函数
function getServerName(instanceId: string, minekuaiConfig: MinekuaiConfig, servers: ServerConfig[]): string {
  const mapping = minekuaiConfig.instances?.find(m => m.instanceId === instanceId)
  if (mapping) {
    const server = servers.find(s => s.id === mapping.id)
    return server ? server.name : `服务器ID: ${mapping.id}`
  }
  return instanceId
}

// 将中文操作类型映射为英文操作类型
function mapActionToEnglish(action: string): string {
  const actionMap: { [key: string]: string } = {
    '启动': 'start',
    '关闭': 'stop',
    '重启': 'restart',
    '强制关闭': 'kill'
  }
  
  return actionMap[action] || action
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

    let retryCount = 0
    const maxRetries = 3
    const retryDelay = 1000 // 1秒延迟

    while (retryCount <= maxRetries) {
      try {
        const response = await ctx.http.get(apiUrl, {
          timeout: 5000 // 设置5秒超时
        })

        if (response.status !== 'online') {
          return `🔴 [${server.id}] ${server.name}\n🌐 IP: ${hostWithPort}\n状态: 离线`
        }

        let message = `🟢 [${server.id}] ${server.name}\n`
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
        retryCount++
        
        if (retryCount <= maxRetries) {
          ctx.logger('minecraft-search').warn(`查询服务器 ${server.id} ${server.name} 失败，第 ${retryCount} 次重试...`, error.message)
          // 等待一段时间后重试
          await new Promise(resolve => setTimeout(resolve, retryDelay * retryCount))
        } else {
          ctx.logger('minecraft-search').warn(`查询服务器 ${server.id} ${server.name} 重试 ${maxRetries} 次后失败`, error)
          // 修改为友好的错误提示
          throw new Error('服务器繁忙，请稍后再试。')
        }
      }
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

    // 新增：无权限要求的开服指令
    ctx.command('开服 <serverId:string>')
      .action(async ({ session }, serverId) => {
        if (!serverId) {
          return '❌ 请提供服务器ID。使用"mc/服务器列表"查看可用服务器'
        }

        if (!minekuaiConfig.instances || minekuaiConfig.instances.length === 0) {
          return '❌ 未配置任何服务器与实例的映射关系，无法执行开服操作'
        }

        try {
          // 解析标识符（支持服务器ID）
          const instanceId = resolveInstanceIdentifier(serverId, minekuaiConfig, config.servers)
          const serverName = getServerName(instanceId, minekuaiConfig, config.servers)
          
          await minekuaiRequest(ctx, minekuaiConfig, `/servers/${instanceId}/power`, 'POST', {
            "signal": "start"
          })

          return `✅ 已发送启动指令到服务器 ${serverName} (ID: ${serverId})，服务器正在启动中，请稍后使用"mc/查服 ${serverId}"查看状态`
        } catch (error) {
          return `❌ 开服失败: ${error.message}`
        }
      })

    // 新增：显示实例映射关系命令
    ctx.command('麦块/实例映射', { authority: 3 })
      .action(async ({ session }) => {
        if (!minekuaiConfig.instances || minekuaiConfig.instances.length === 0) {
          return '❌ 未配置任何服务器与实例的映射关系'
        }

        let message = '📋 服务器与实例映射关系:\n'
        minekuaiConfig.instances.forEach((mapping, index) => {
          const server = config.servers.find(s => s.id === mapping.id)
          const serverName = server ? server.name : '未知服务器'
          message += `\n${index + 1}. 服务器: ${serverName} (ID: ${mapping.id}) → 实例ID: ${mapping.instanceId}`
        })

        return message
      })

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
            const serverName = getServerName(attrs.identifier, minekuaiConfig, config.servers)
            message += `\n${index + 1}. ${removeFormatting(attrs.name || serverName)}\n`
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
          return '❌ 请提供实例标识符或服务器ID'
        }

        try {
          // 解析标识符（支持服务器ID或实例ID）
          const instanceId = resolveInstanceIdentifier(identifier, minekuaiConfig, config.servers)
          const serverName = getServerName(instanceId, minekuaiConfig, config.servers)
          
          const response = await minekuaiRequest(ctx, minekuaiConfig, `/servers/${instanceId}`)

          if (!response || !response.attributes) {
            return '❌ 未找到指定实例'
          }

          const attrs = response.attributes
          const allocations = attrs.relationships?.allocations?.data || []
          const defaultAllocation = allocations.find((alloc: any) => alloc.attributes.is_default) || allocations[0]

          let message = `🖥️ 实例信息: ${removeFormatting(attrs.name || serverName)}\n`
          message += `🔧 标识符: ${instanceId}\n`
          if (identifier !== instanceId) {
            message += `🔗 对应服务器ID: ${identifier}\n`
          }
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
          return '❌ 请提供实例标识符或服务器ID'
        }

        try {
          // 解析标识符（支持服务器ID或实例ID）
          const instanceId = resolveInstanceIdentifier(identifier, minekuaiConfig, config.servers)
          const serverName = getServerName(instanceId, minekuaiConfig, config.servers)
          
          const response = await minekuaiRequest(ctx, minekuaiConfig, `/servers/${instanceId}/resources`)

          if (!response || !response.attributes) {
            return '❌ 未找到指定实例的资源信息'
          }

          const attrs = response.attributes
          const resources = attrs.resources

          let message = `📊 实例资源使用情况: ${serverName}\n`
          if (identifier !== instanceId) {
            message += `🔗 对应服务器ID: ${identifier}\n`
          }
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
          return '❌ 请提供实例标识符/服务器ID和操作类型 (启动/关闭/重启/强制关闭)'
        }

        // 将中文操作类型映射为英文
        const englishAction = mapActionToEnglish(action)
        
        const validActions = ['启动', '关闭', '重启', '强制关闭']
        const validEnglishActions = ['start', 'stop', 'restart', 'kill']
        
        if (!validActions.includes(action) && !validEnglishActions.includes(englishAction)) {
          return `❌ 无效的操作类型。可用操作: ${validActions.join(', ')}`
        }

        try {
          // 解析标识符（支持服务器ID或实例ID）
          const instanceId = resolveInstanceIdentifier(identifier, minekuaiConfig, config.servers)
          const serverName = getServerName(instanceId, minekuaiConfig, config.servers)
          
          await minekuaiRequest(ctx, minekuaiConfig, `/servers/${instanceId}/power`, 'POST', {
            "signal": englishAction
          })

          let message = `✅ 已发送 ${action} 指令到实例 ${serverName}`
          if (identifier !== instanceId) {
            message += ` (服务器ID: ${identifier})`
          }
          return message
        } catch (error) {
          return `❌ 电源操作失败: ${error.message}`
        }
      })

    // 麦块联机实例发送命令
    ctx.command('麦块/实例命令 <identifier:string> <command:text>', { authority: 3 })
      .action(async ({ session }, identifier, command) => {
        if (!identifier || !command) {
          return '❌ 请提供实例标识符/服务器ID和命令内容'
        }

        try {
          // 解析标识符（支持服务器ID或实例ID）
          const instanceId = resolveInstanceIdentifier(identifier, minekuaiConfig, config.servers)
          const serverName = getServerName(instanceId, minekuaiConfig, config.servers)
          
          await minekuaiRequest(ctx, minekuaiConfig, `/servers/${instanceId}/command`, 'POST', {
            command: command
          })

          let message = `✅ 已发送命令到实例 ${serverName}: ${command}`
          if (identifier !== instanceId) {
            message += ` (服务器ID: ${identifier})`
          }
          return message
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