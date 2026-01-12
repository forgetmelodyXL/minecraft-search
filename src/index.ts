import { Context, Schema, h } from 'koishi'

export const name = 'minecraft-status'

// 服务器配置接口
export interface ServerConfig {
  id: number
  name: string
  host: string
  minekuaiInstanceId?: string  // 新增：麦块实例ID
}

export interface Config {
  servers: ServerConfig[]
  querySettings: QuerySettings
  minekuaiSettings: MinekuaiSettings  // 新增：麦块联机配置
}

export interface QuerySettings {
  defaultTimeout: number
  enableQuery: boolean
  showIcon: boolean
  showPlayers: boolean
  showPlugins: boolean
  showMods: boolean
  cacheTime: number
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
      host: Schema.string().required().description('服务器地址 (如: play.hypixel.net)'),
      minekuaiInstanceId: Schema.string().description('麦块实例ID (用于电源控制)')
    })).description('服务器列表').role('table').default([
      { id: 1, name: 'Hypixel', host: 'mc.hypixel.net', minekuaiInstanceId: '' },
      { id: 2, name: 'Minecraft 官方演示', host: 'demo.mcstatus.io', minekuaiInstanceId: '' }
    ])
  }).description('服务器配置'),

  Schema.object({
    querySettings: Schema.object({
      defaultTimeout: Schema.number().min(1).max(30).description('请求超时时间(秒)').default(5),
      enableQuery: Schema.boolean().description('启用查询功能获取插件信息').default(true),
      showIcon: Schema.boolean().description('显示服务器图标').default(true),
      showPlayers: Schema.boolean().description('显示在线玩家').default(true),
      showPlugins: Schema.boolean().description('显示插件列表').default(false),
      showMods: Schema.boolean().description('显示模组列表').default(false),
      cacheTime: Schema.number().min(0).max(3600).description('状态缓存时间(秒)').default(30)
    })
  }).description('查询设置'),

  // 新增：麦块联机配置分类
  Schema.object({
    minekuaiSettings: Schema.object({
      apiUrl: Schema.string().description('麦块API地址').default('https://minekuai.com/api/client'),
      apiKey: Schema.string().description('麦块API密钥').default('')
    })
  }).description('麦块联机配置')
])

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

    // 清理API地址，确保格式正确
    const baseUrl = apiUrl.replace(/\/+$/, '') // 移除末尾的斜杠
    const url = `${baseUrl}/servers/${instanceId}/power`  // 修改端点格式

    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    }

    // 根据官方示例，参数名应该是 "signal" 而不是 "operation"
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
        // 发送重启指令
        await minekuaiApiRequest(server.minekuaiInstanceId, 'restart', 3)

        // 延迟1秒后发送kill指令
        await new Promise(resolve => setTimeout(resolve, 1000))
        await minekuaiApiRequest(server.minekuaiInstanceId, 'kill', 3)

        return `✅ 已发送重启指令到服务器 ${server.name} (ID: ${id})`
      } catch (error) {
        return `❌ 重启服务器 ${server.name} 失败: ${error.message}`
      }
    })

  // 原有主指令保持不变
  ctx.command('mcstatus [server]', '查询 Minecraft 服务器状态')
    .alias('服务器状态', '查服')
    .option('list', '-l 查看服务器列表')
    .option('info', '-i <id> 查看服务器详细信息', { type: 'number' })
    .option('timeout', '-t <seconds> 设置超时时间', { type: 'number' })
    .option('force', '-f 强制刷新缓存')
    .action(async ({ session, options }, server) => {
      // 查看服务器列表
      if (options.list) {
        return getServerList(config.servers)
      }

      // 查看指定ID的服务器详细信息
      if (options.info) {
        const server = config.servers.find(s => s.id === options.info)
        if (!server) {
          return `未找到ID为 ${options.info} 的服务器`
        }
        return getServerInfo(server, config, options.force, options.timeout || config.querySettings.defaultTimeout)
      }

      // 无参数时显示所有服务器状态
      if (!server) {
        return getAllServersStatus(config, options.force, options.timeout || config.querySettings.defaultTimeout)
      }

      // 通过名称或ID查询
      const serverConfig = config.servers.find(s => s.name === server || s.id.toString() === server)
      if (serverConfig) {
        return getServerInfo(serverConfig, config, options.force, options.timeout || config.querySettings.defaultTimeout)
      }

      // 直接通过地址查询
      return getDirectServerStatus(server, config, options.force, options.timeout || config.querySettings.defaultTimeout)
    })

  // 辅助函数：获取服务器列表（增加麦块实例ID显示）
  function getServerList(servers: ServerConfig[]) {
    if (servers.length === 0) {
      return '暂无服务器配置，请在插件配置中添加服务器。'
    }

    const list = servers
      .sort((a, b) => a.id - b.id)
      .map(s => `#${s.id} ${s.name} - ${s.host}${s.minekuaiInstanceId ? ` [麦块实例: ${s.minekuaiInstanceId}]` : ''}`)
      .join('\n')

    return h('message', [
      h('p', '已配置的服务器列表:'),
      h('p', list),
      h('p', { style: { color: '#888', fontSize: '12px' } }, '使用"开服 ID"和"重启 ID"命令控制麦块服务器')
    ])
  }

  // 其余辅助函数保持不变
  async function getAllServersStatus(config: Config, force: boolean, timeout: number) {
    if (config.servers.length === 0) {
      return '暂无服务器配置。使用 "mcstatus -l" 查看如何添加服务器。'
    }

    const results = await Promise.all(
      config.servers.map(async server => {
        try {
          const status = await getServerStatus(server.host, timeout, config.querySettings.enableQuery, force)
          return {
            name: server.name,
            online: status.online,
            players: status.online ? `${status.players.online}/${status.players.max}` : '离线',
            version: status.online ? status.version.name_clean : '未知',
            motd: status.online ? status.motd.clean : ''
          }
        } catch (error) {
          return {
            name: server.name,
            online: false,
            players: '错误',
            version: '未知',
            motd: ''
          }
        }
      })
    )

    const onlineCount = results.filter(r => r.online).length
    const message = h('message', [
      h('p', `服务器状态监控 (${onlineCount}/${config.servers.length} 在线)`),
      ...results.map(r => h('p', [
        `${r.online ? '🟢' : '🔴'} ${r.name} | `,
        h('span', { style: { color: r.online ? '#00ff00' : '#ff0000' } }, r.online ? '在线' : '离线'),
        ` | 玩家: ${r.players} | 版本: ${r.version}`
      ]))
    ])

    return message
  }

  async function getServerInfo(server: ServerConfig, config: Config, force: boolean, timeout: number) {
    try {
      const status = await getServerStatus(server.host, timeout, config.querySettings.enableQuery, force)

      if (!status.online) {
        return h('message', [
          h('p', `🔴 ${server.name} (${server.host})`),
          h('p', '服务器当前处于离线状态'),
          h('p', { style: { color: '#ff6666' } }, '无法连接到服务器，请检查地址是否正确或服务器是否正常运行。')
        ])
      }

      const message = h('message')

    // 处理服务器图标
    let iconElement = null
    if (config.querySettings.showIcon && status.icon) {
      try {
        // mcstatus API 返回的 icon 已经是 data:image/png;base64,... 格式
        // 直接使用 h.image 应该能处理，但需要确保格式正确
        if (status.icon.startsWith('data:image/')) {
          iconElement = h.image(status.icon)
        } else if (status.icon.startsWith('http')) {
          // 如果是 URL，直接使用
          iconElement = h.image(status.icon)
        } else {
          // 如果是纯 Base64，添加前缀
          iconElement = h.image(`base64://${status.icon}`)
        }
      } catch (error) {
        ctx.logger.warn('处理服务器图标失败:', error)
        // 图标处理失败，不显示图标
      }
    }
    
    // 服务器基本信息
    message.children.push(
      h('p', [
        iconElement ? h('span', [iconElement, ' ']) : '',
        `🟢 ${server.name}`
      ]),
      h('p', `📍 地址: ${server.host}`),
      h('p', `🎮 版本: ${status.version.name_clean} (协议: ${status.version.protocol})`),
      h('p', `📅 状态获取时间: ${new Date(status.retrieved_at).toLocaleString('zh-CN')}`)
    )

      // MOTD
      if (status.motd) {
        const cleanMotd = status.motd.clean
          .replace(/\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (cleanMotd) {
          message.children.push(
            h('p', '📋 MOTD: ' + cleanMotd.substring(0, 100) + (cleanMotd.length > 100 ? '...' : ''))
          )
        }
      }

      // 玩家信息
      if (config.querySettings.showPlayers && status.players) {
        message.children.push(
          h('p', `👥 在线人数: ${status.players.online}/${status.players.max}`)
        )
        if (status.players.list && status.players.list.length > 0) {
          const samplePlayers = status.players.list
            .slice(0, 5)
            .map(p => p.name_clean)
            .join(', ')
          message.children.push(
            h('p', `📊 玩家: ${samplePlayers}`)
          )
        }
      }

      // 软件信息
      if (status.software) {
        message.children.push(
          h('p', `💻 核心: ${status.software}`)
        )
      }

      // 插件信息
      if (config.querySettings.showPlugins && status.plugins && status.plugins.length > 0) {
        const pluginCount = status.plugins.length
        const pluginList = status.plugins
          .slice(0, 5)
          .map(p => p.version ? `${p.name} v${p.version}` : p.name)
          .join(', ')
        message.children.push(
          h('p', `🔌 插件 (${pluginCount}个): ${pluginList}`)
        )
      }

      // 模组信息
      if (config.querySettings.showMods && status.mods && status.mods.length > 0) {
        const modCount = status.mods.length
        const modList = status.mods
          .slice(0, 5)
          .map(m => m.version ? `${m.name} v${m.version}` : m.name)
          .join(', ')
        message.children.push(
          h('p', `⚙️ 模组 (${modCount}个): ${modList}`)
        )
      }

      // SRV记录
      if (status.srv_record) {
        message.children.push(
          h('p', `🔗 SRV记录: ${status.srv_record.host}:${status.srv_record.port}`)
        )
      }

      // 缓存信息
      if (status.expires_at) {
        const cacheTime = Math.max(0, Math.floor((status.expires_at - Date.now()) / 1000))
        message.children.push(
          h('p', { style: { fontSize: '12px', color: '#888' } },
            `⏱️ 缓存剩余: ${cacheTime}秒 | 使用 -f 强制刷新`
          )
        )
      }

      return message
    } catch (error) {
      ctx.logger.error('MC状态查询失败:', error)
      return h('message', [
        h('p', `❌ 查询 ${server.name} 失败`),
        h('p', { style: { color: '#ff6666' } }, '请检查: 1) 服务器地址是否正确 2) 服务器是否在线 3) 网络连接是否正常')
      ])
    }
  }

  async function getDirectServerStatus(address: string, config: Config, force: boolean, timeout: number) {
    try {
      const status = await getServerStatus(address, timeout, config.querySettings.enableQuery, force)

      if (!status.online) {
        return h('message', [
          h('p', `🔴 ${address}`),
          h('p', '服务器当前处于离线状态')
        ])
      }

      return h('message', [
        h('p', `🟢 ${address}`),
        h('p', `版本: ${status.version.name_clean}`),
        h('p', `玩家: ${status.players.online}/${status.players.max}`),
        h('p', `MOTD: ${status.motd.clean.replace(/\n/g, ' ').substring(0, 50)}...`)
      ])
    } catch (error) {
      return `无法查询服务器: ${address}。请检查地址是否正确。`
    }
  }

  // 核心函数：获取服务器状态 - 已修复URL构建问题
  async function getServerStatus(address: string, timeout: number, enableQuery: boolean, force: boolean) {
    // 验证地址是否有效
    if (!address || address.trim() === '') {
      throw new Error('服务器地址不能为空')
    }

    const cacheKey = `mcstatus:${address}:${enableQuery}`

    // 检查缓存
    if (!force) {
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < config.querySettings.cacheTime * 1000) {
        return cached.data
      }
    }

    // 构建URL - 已修复，使用正确的mcstatus API地址
    const url = `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}`
    const params = {
      query: enableQuery.toString(),
      timeout: timeout.toString()
    }

    try {
      // 发送请求
      const response = await ctx.http.get(url, { params })

      // 缓存结果
      cache.set(cacheKey, {
        data: response,
        timestamp: Date.now()
      })

      return response
    } catch (error) {
      ctx.logger.error(`查询服务器状态失败: ${address}`, error)
      throw new Error(`查询服务器状态失败: ${address}`)
    }
  }

  // 定期清理缓存
  setInterval(() => {
    const now = Date.now()
    for (const [key, value] of cache.entries()) {
      if (now - value.timestamp > config.querySettings.cacheTime * 1000) {
        cache.delete(key)
      }
    }
  }, 60000)
}