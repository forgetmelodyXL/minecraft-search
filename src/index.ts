import { Context, Schema } from 'koishi'

export const name = 'minecraft-search'

export interface Config {
  server: string
  picture: '1.jpg' | '2.jpg' | '3.jpg' | '4.jpg' | '5.jpg' | '6.jpg' | '7.jpg' | '8.jpg' | '9.jpg'
}

export const Config: Schema<Config> = Schema.object({
  server: Schema.string().description('mc服务器地址').required(),
  picture: Schema.union(['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg', '6.jpg', '7.jpg', '8.jpg', '9.jpg']).description('背景图').default('3.jpg'),
})

export function apply(ctx: Context, config: Config) {
  // write your plugin here
  ctx.command('mc/查服')
    .action(async (agrv) => {
      const session = agrv.session
      session.send(`<img src="https://api.imlazy.ink/mcapi/?name=Minecraft 服务器&host=${config.server}&type=image&getmotd=%0a%0a&getbg=${config.picture}"/>`)

    });

}
