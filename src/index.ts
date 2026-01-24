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
  apiSettings: ApiSettings // 新增：API配置
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

// 新增：API配置接口
export interface ApiSettings {
  apiProvider: 'mcstatus' | 'lazy' // API提供商：mcstatus.io 或 Lazy API
  lazyApiUrl: string // Lazy API地址
  useBackup: boolean // 是否使用备用地址
  returnType: 'json' | 'image' | 'html' // 返回类型
  autoDetectBedrock: boolean // 自动检测基岩版
}

export const Config: Schema<Config> = Schema.intersect([
  // 新增：API配置分类
  Schema.object({
    apiSettings: Schema.object({
      apiProvider: Schema.union([
        Schema.const('mcstatus' as const).description('mcstatus.io API (默认)'),
        Schema.const('lazy' as const).description('Lazy Minecraft API')
      ]).description('API提供商选择').default('mcstatus'),
      lazyApiUrl: Schema.string().description('Lazy API地址').default('https://api.imlazy.ink/mcapi'),
      useBackup: Schema.boolean().description('使用备用API地址').default(false),
      returnType: Schema.union([
        Schema.const('json' as const).description('JSON格式'),
        Schema.const('image' as const).description('图片格式'),
        Schema.const('html' as const).description('网页格式')
      ]).description('返回类型 (仅Lazy API)').default('json'),
      autoDetectBedrock: Schema.boolean().description('自动检测基岩版服务器').default(true)
    })
  }).description('API设置'),

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
    .option('api', '-a <provider> 临时切换API提供商', { type: 'string' })
    .action(async ({ session, options }, server) => {
      // 临时API切换
      if (options.api) {
        const tempProvider = options.api.toLowerCase()
        if (['mcstatus', 'lazy'].includes(tempProvider)) {
          const originalProvider = config.apiSettings.apiProvider
          config.apiSettings.apiProvider = tempProvider as 'mcstatus' | 'lazy'
          // 执行查询后恢复原设置
          try {
            const result = await handleMcStatusCommand(server, options)
            return result
          } finally {
            config.apiSettings.apiProvider = originalProvider
          }
        } else {
          return '❌ 无效的API提供商，可选: mcstatus, lazy'
        }
      }

      return await handleMcStatusCommand(server, options)
    })

  // 新增：提取原来的命令处理逻辑
  async function handleMcStatusCommand(server: string, options: any) {
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
  }

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

// 修改 getServerInfo 函数中的版本显示部分
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
        if (status.icon.startsWith('data:image/')) {
          iconElement = h.image(status.icon)
        } else if (status.icon.startsWith('http')) {
          iconElement = h.image(status.icon)
        } else {
          iconElement = h.image(`base64://${status.icon}`)
        }
      } catch (error) {
        ctx.logger.warn('处理服务器图标失败:', error)
      }
    }
    
    // 服务器基本信息
    message.children.push(
      h('p', [
        iconElement ? h('span', [iconElement, ' ']) : '',
        `🟢 ${server.name}`
      ]),
      h('p', `📍 地址: ${server.host}`)
    )

    // 版本信息显示优化
    let versionDisplay = `🎮 版本: ${status.version.name_clean}`
    if (status.version.protocol && status.version.protocol !== 0) {
      versionDisplay += ` (协议: ${status.version.protocol})`
    }
    message.children.push(h('p', versionDisplay))

    message.children.push(
      h('p', `📅 状态获取时间: ${new Date(status.retrieved_at).toLocaleString('zh-CN')}`)
    )

    // MOTD 处理（去除颜色代码）
    if (status.motd) {
      let cleanMotd = status.motd.clean
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/§./g, '') // 去除颜色代码
      
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

    // 移除核心信息显示（根据用户要求）
    // if (status.software) {
    //   message.children.push(
    //     h('p', `💻 核心: ${status.software}`)
    //   )
    // }

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

  // 修改后的核心查询函数
  async function getServerStatus(address: string, timeout: number, enableQuery: boolean, force: boolean) {
    if (!address || address.trim() === '') {
      throw new Error('服务器地址不能为空')
    }

    const cacheKey = `mcstatus:${address}:${enableQuery}:${config.apiSettings.apiProvider}`

    // 检查缓存
    if (!force) {
      const cached = cache.get(cacheKey)
      if (cached && Date.now() - cached.timestamp < config.querySettings.cacheTime * 1000) {
        return cached.data
      }
    }

    let response
    const { apiProvider } = config.apiSettings

    try {
      if (apiProvider === 'lazy') {
        // 使用Lazy API
        response = await queryWithLazyApi(address, timeout)
      } else {
        // 使用默认的mcstatus.io API（原有逻辑）
        const url = `https://api.mcstatus.io/v2/status/java/${encodeURIComponent(address)}`
        const params = {
          query: enableQuery.toString()
        }
        response = await ctx.http.get(url, {
          params,
          timeout: timeout * 1000 + 5000
        })
      }

      // 缓存结果
      cache.set(cacheKey, {
        data: response,
        timestamp: Date.now()
      })

      ctx.logger.debug(`${apiProvider.toUpperCase()} API查询成功: ${address}`)
      return response

    } catch (error) {
      ctx.logger.error(`${apiProvider.toUpperCase()} API查询失败: ${address}`, error)
      throw new Error(`查询服务器状态失败: ${address} (${error.message})`)
    }
  }

  // 新增：Lazy API请求函数
  async function queryWithLazyApi(host: string, timeout: number) {
    const { lazyApiUrl, useBackup, returnType, autoDetectBedrock } = config.apiSettings

    // 选择API地址
    const baseUrl = useBackup ? 'https://api.lazy.ink/mcapi' : lazyApiUrl

    const params = new URLSearchParams({
      type: returnType,
      host: host
    })

    if (autoDetectBedrock) {
      // 这里可以添加基岩版检测逻辑
      params.append('be', 'false') // 默认false，可根据需要调整
    }

    const url = `${baseUrl}?${params.toString()}`

    try {
      const response = await ctx.http.get(url, { timeout: timeout * 1000 })
      return transformLazyResponse(response, host)
    } catch (error) {
      ctx.logger.error('Lazy API查询失败:', error)
      throw new Error(`Lazy API查询失败: ${error.message}`)
    }
  }

// 修改 transformLazyResponse 函数
function transformLazyResponse(lazyData: any, host: string) {
  // 处理 MOTD - 将 extra 数组中的文本拼接，并去除颜色代码
  let cleanMotd = '';
  if (lazyData.motd && lazyData.motd.extra) {
    cleanMotd = lazyData.motd.extra.map((item: any) => item.text).join('');
    // 去除颜色代码（§字符及其后一个字符）
    cleanMotd = cleanMotd.replace(/§./g, '');
  }
  
  // 处理版本信息
  let versionName = lazyData.version || 'Unknown';
  if (versionName === 'Unknown' || !versionName) {
    versionName = '未知';
  }
  
  return {
    online: lazyData.status === '在线',
    host: lazyData.host || host,
    version: {
      name_clean: versionName,
      protocol: lazyData.protocol || 0
    },
    players: {
      online: lazyData.players_online || 0,
      max: lazyData.players_max || 0,
      list: (lazyData.players || []).map((p: any) => ({ 
        name_clean: p.name 
      }))
    },
    motd: {
      clean: cleanMotd || lazyData.motd?.text || 'A Minecraft Server'
    },
    icon: lazyData.favicon || null,
    software: lazyData.software || '',
    plugins: lazyData.plugins || [],
    mods: lazyData.mods || [],
    retrieved_at: Date.now(),
    expires_at: Date.now() + (config.querySettings.cacheTime * 1000)
  };
}

  // 新增：API状态检查命令
  ctx.command('mcstatus.api', '检查API状态')
    .option('switch', '-s <provider> 切换API提供商', { type: 'string' })
    .option('test', '-t 测试所有API')
    .action(async ({ session, options }) => {
      if (options.switch) {
        if (['mcstatus', 'lazy'].includes(options.switch.toLowerCase())) {
          config.apiSettings.apiProvider = options.switch.toLowerCase() as 'mcstatus' | 'lazy'
          return `✅ 已切换API提供商为: ${options.switch.toUpperCase()}`
        } else {
          return '❌ 无效的API提供商，可选: mcstatus, lazy'
        }
      }

      if (options.test) {
        const testServers = [
          { name: 'Hypixel', host: 'mc.hypixel.net' },
          { name: '演示服务器', host: 'demo.mcstatus.io' }
        ]

        const results = []
        for (const server of testServers) {
          try {
            const startTime = Date.now()
            await getServerStatus(server.host, 5, false, true)
            const responseTime = Date.now() - startTime
            results.push(`🟢 ${server.name}: ${responseTime}ms`)
          } catch (error) {
            results.push(`🔴 ${server.name}: 失败`)
          }
        }

        return h('message', [
          h('p', `当前API提供商: ${config.apiSettings.apiProvider.toUpperCase()}`),
          h('p', 'API测试结果:'),
          ...results.map(r => h('p', r)),
          h('p', { style: { fontSize: '12px', color: '#888' } },
            '使用 "mcstatus.api -s <provider>" 切换API')
        ])
      }

      return h('message', [
        h('p', `当前API提供商: ${config.apiSettings.apiProvider.toUpperCase()}`),
        h('p', `Lazy API地址: ${config.apiSettings.useBackup ? '备用地址' : config.apiSettings.lazyApiUrl}`),
        h('p', `返回类型: ${config.apiSettings.returnType.toUpperCase()}`),
        h('p', { style: { fontSize: '12px', color: '#888' } },
          '使用 "mcstatus.api -t" 测试API或 "mcstatus.api -s <provider>" 切换')
      ])
    })

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