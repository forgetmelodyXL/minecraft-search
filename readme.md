# koishi-plugin-minecraft-search

[![npm](https://img.shields.io/npm/v/koishi-plugin-minecraft-search?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-minecraft-search)

一个用于查询 Minecraft 服务器状态和控制麦块联机服务器的 Koishi 插件。

## 功能特性

### 🎮 服务器状态查询
- 支持 Java 版服务器
- 支持查询全部服务器状态（简短信息）
- 支持查询指定服务器状态（详细信息）
- 可配置查询超时时间
- 自动移除 Minecraft 颜色代码，显示纯文本 MOTD

### ⚡ 服务器电源控制
- 支持通过麦块联机 API 启动服务器
- 支持通过麦块联机 API 重启服务器
- 自动重试机制，提高操作成功率

## 安装

1. 安装插件：
```bash
npm install koishi-plugin-minecraft-search
```

2. 在 Koishi 配置文件中启用插件。

## 配置说明

### 服务器配置
```typescript
servers: [
  {
    id: 1,                    // 服务器ID（数字）
    name: "主服务器",          // 服务器名称
    host: "play.example.com:25565", // 服务器地址（支持带端口）
    serverType: "java",       // 服务器类型：java/bedrock
    timeout: 5.0,            // 查询超时时间（秒）
    minekuaiInstanceId: "xxx" // 麦块实例ID（可选，用于电源控制）
  }
]
```

### 麦块联机配置（可选）
```typescript
minekuaiSettings: {
  apiUrl: "https://minekuai.com/api/client", // 麦块API地址
  apiKey: "your-api-key"                     // 麦块API密钥
}
```

## 使用指令

### 查询服务器状态
```
查服        # 查询全部服务器状态（简短信息）
查服 1      # 查询ID为1的服务器的详细信息
```

**输出示例：**
```
📊 服务器状态汇总 (当前在线2/3台)

[ID:1] 🟢 主服务器 - 在线 | 玩家: 15/50 | 版本: 1.20.1
[ID:2] 🟢 生存服 - 在线 | 玩家: 8/30 | 版本: 1.19.4
[ID:3] 🔴 创造服 - 离线

💡 输入"查服+服务器ID"即可查询详细状态，例如：查服 1
```

### 服务器电源控制
```
开服 1      # 启动ID为1的麦块服务器
重启 1      # 重启ID为1的麦块服务器
强制重启 1  # 强制重启ID为1的麦块服务器
```

## 配置选项说明

### 服务器类型 (serverType)
- `java`：Java 版服务器（默认）
- `bedrock`：基岩版服务器（暂不支持）

### 超时时间 (timeout)
- 默认值：5.0 秒
- 设置查询超时时间，避免长时间等待

## 技术特性

- 🔄 **自动重试机制**：API 请求失败时自动重试，提高成功率
- 🎯 **智能地址解析**：自动分离主机名和端口
- 📱 **友好输出格式**：使用 emoji 和清晰排版，信息易读
- ⚡ **高性能查询**：支持并行查询多个服务器
- 🛡️ **错误处理**：完善的错误处理和用户提示

## 依赖说明

- 使用 https://www.npmjs.com/package/mc-server-util 库进行服务器状态查询
- 支持麦块联机平台的 API 集成
- 基于 Koishi 框架开发

## 注意事项

1. 麦块联机功能需要配置正确的 API 地址和密钥
2. Query 查询可能会增加查询时间，建议按需开启
3. 服务器地址支持带端口格式（如：`play.example.com:25565`）
4. 插件会自动处理 MOTD 中的换行符，确保输出整洁

## 故障排除

如果遇到查询失败，请检查：
- 服务器地址是否正确
- 网络连接是否正常
- 防火墙是否阻止了查询请求
- 麦块 API 配置是否正确

## 更新日志

### v1.3.0
- 替换服务器状态查询库为 mc-server-util
- 移除对基岩版服务器的支持（暂不支持）
- 移除 Query 查询选项
- 添加自动移除 Minecraft 颜色代码功能
- 优化错误处理和类型检查

### v1.1.1
- 初始版本发布
- 支持服务器状态查询
- 支持麦块联机电源控制
- 支持 Java 和基岩版服务器

## 支持与反馈

如有问题或建议，请通过相关渠道联系开发者。
