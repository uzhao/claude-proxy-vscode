# Claude Proxy

一个简单的 VSCode 扩展,为 Claude API 提供代理服务。

## 功能特性

- 🔄 支持多个 AI 服务提供商
  - Anthropic 官方 API
  - GLM (智谱AI)
  - Kimi (Moonshot)
  - MiniMax
  - DeepSeek
  - 自定义 Provider
  - LiteLLM 本地代理
  - CLIProxyAPI 本地代理

- ⚙️ 灵活的模型映射
  - Haiku 模型映射配置
  - Main 模型 (Sonnet/Opus) 映射配置

- 📝 可选的请求日志记录
  - 将请求和响应保存为 JSON 文件

## 安装

1. 克隆仓库
2. 运行 `npm install` 安装依赖
3. 在 VSCode 中按 `F5` 启动调试

## 配置

在 VSCode 设置中搜索 "Claude Proxy" 可以找到所有配置选项:

- **端口设置**: 配置代理服务器监听端口(默认: 4001)
- **日志记录**: 启用/禁用 JSON 日志记录
- **模型映射**: 配置 Haiku 和 Main 模型的映射目标
- **提供商配置**: 为各个 AI 服务提供商配置 API 密钥和可用模型

## 使用方法

1. 在设置中启用至少一个 Provider
2. 配置对应的 API 密钥
3. 配置可用的模型列表
4. 使用命令面板选择模型映射:
   - `Claude Proxy: 选择Haiku映射目标`
   - `Claude Proxy: 选择Main映射目标`

## 开发

```bash
# 编译
npm run compile

# 监视模式
npm run watch
```

## 许可证

MIT
