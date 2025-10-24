import { Context, Schema } from 'koishi'

export const name = 'minecraft-search'

export interface Config {
  server: string
  picture: '1.jpg' | '2.jpg' | '3.jpg' | '4.jpg' | '5.jpg' | '6.jpg' | '7.jpg' | '8.jpg' | '9.jpg'
  type: 'json' | 'image'
}

export const Config: Schema<Config> = Schema.object({
  server: Schema.string().description('MC服务器地址').required(),
    type: Schema.union(['json', 'image'])
    .description('返回格式类型')
    .default('image'),
  picture: Schema.union([
    '1.jpg', '2.jpg', '3.jpg', '4.jpg', 
    '5.jpg', '6.jpg', '7.jpg', '8.jpg', '9.jpg'
  ]).description('背景图').default('3.jpg'),
})

// 去除Minecraft格式符号的辅助函数
function removeFormatting(str: string): string {
  return str.replace(/§[0-9a-fk-or]/g, '')
}

export function apply(ctx: Context, config: Config) {
  ctx.command('mc/查服')
    .action(async ({ session }) => {
      const { server, picture, type } = config
      const apiUrl = `https://api.imlazy.ink/mcapi/?name=Minecraft%20服务器&host=${server}&type=${type}&getmotd=%0a%0a&getbg=${picture}`

      try {
        if (type === 'image') {
          await session.send(`<img src="${apiUrl}"/>`)
        } else {
          const response = await ctx.http.get(apiUrl)
          
          // 处理服务器离线情况
          if (response.status !== '在线') {
            return `服务器 ${server} 当前离线`
          }
          
          // 构建响应消息
          let message = `🟢 服务器信息 [${response.name}]\n`
          message += `🔗 地址: ${response.host}\n`
          message += `📝 MOTD: \n${removeFormatting(response.motd.text)}\n`
          message += `👥 玩家: ${response.players_online}/${response.players_max}\n`
          
          // 添加在线玩家列表
          if (response.players_online > 0) {
            const playerNames = response.players.map(p => p.name)
            message += `🎮 在线玩家: ${playerNames.join(', ')}`
          } else {
            message += '🎮 当前没有在线玩家'
          }
          
          await session.send(message)
        }
      } catch (error) {
        ctx.logger('minecraft-search').warn('查询服务器失败', error)
        return `查询服务器失败: ${error.message}`
      }
    })
}