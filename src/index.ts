import { Context, Schema } from 'koishi'

export const name = 'minecraft-search'

export interface ServerConfig {
  name: string
  host: string
  port: number
}

export interface Config {
  servers: ServerConfig[]
}

export const Config: Schema<Config> = Schema.object({
  servers: Schema.array(Schema.object({
    name: Schema.string().description('服务器名称').required(),
    host: Schema.string().description('服务器地址').required(),
    port: Schema.number().description('服务器端口').default(25565),
  }))
    .description('Minecraft服务器列表')
    .role('table')
    .collapse()
    .required(),
})

// 去除Minecraft格式符号的辅助函数
function removeFormatting(str: string): string {
  return str.replace(/§[0-9a-fk-or]/g, '')
}

export function apply(ctx: Context, config: Config) {
  ctx.command('mc/查服 [serverName:string]')
    .action(async ({ session }, serverName) => {
      const { servers } = config
      
      // 如果没有服务器配置
      if (!servers || servers.length === 0) {
        return '未配置任何Minecraft服务器'
      }
      
      // 如果指定了服务器名称，查找特定服务器
      if (serverName) {
        const targetServer = servers.find(server => 
          server.name.toLowerCase() === serverName.toLowerCase()
        )
        
        if (!targetServer) {
          return `未找到名为"${serverName}"的服务器。可用服务器: ${servers.map(s => s.name).join(', ')}`
        }
        
        return await queryServer(targetServer)
      }
      
      // 如果没有指定服务器名称，查询所有服务器
      const results = []
      for (const server of servers) {
        try {
          const result = await queryServer(server)
          results.push(result)
        } catch (error) {
          results.push(`❌ ${server.name} 查询失败: ${error.message}`)
        }
      }
      
      return results.join('\n\n')
    })
    
  async function queryServer(server: ServerConfig) {
    const hostWithPort = `${server.host}:${server.port}`
    const apiUrl = `https://motd.minebbs.com/api/status?ip=${server.host}&port=${server.port}`
    
    try {
      const response = await ctx.http.get(apiUrl)
      
      // 处理服务器离线情况
      if (response.status !== 'online') {
        return `🔴 ${server.name}\n🌐 ${hostWithPort}\n状态: 离线`
      }
      
      // 构建响应消息
      let message = `🟢 ${server.name}\n`
      message += `🌐 IP: ${hostWithPort}\n`
      message += `📝 MOTD: \n${removeFormatting(response.pureMotd || response.motd?.text || '无')}\n`
      message += `🎮 版本: ${response.version} (协议 ${response.protocol})\n`
      message += `👥 玩家: ${response.players.online}/${response.players.max}\n`
      message += `⏱️ 延迟: ${response.delay}ms\n`
      
      // 添加在线玩家列表
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
      ctx.logger('minecraft-search').warn(`查询服务器 ${server.name} 失败`, error)
      throw new Error(`查询失败: ${error.message}`)
    }
  }
  
  // 添加查看服务器列表的命令
  ctx.command('mc/服务器列表')
    .action(async ({ session }) => {
      const { servers } = config
      
      if (!servers || servers.length === 0) {
        return '未配置任何Minecraft服务器'
      }
      
      const serverList = servers.map(server => 
        `• ${server.name} - ${server.host}:${server.port}`
      ).join('\n')
      
      return `📋 已配置的Minecraft服务器:\n${serverList}\n\n使用"mc/查服 服务器名称"查询特定服务器`
    })
}